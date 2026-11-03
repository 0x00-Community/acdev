use std::cell::{Cell, RefCell};
use std::collections::{BinaryHeap, HashMap, VecDeque};
use std::cmp::Reverse;
use std::rc::Rc;
use std::sync::atomic::{AtomicIsize, AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use acde_napi::{LocalTask, ScopeTask};

pub enum Msg {
    Task(ScopeTask),
    V8(v8::Task),
    Delayed(Instant, v8::Task),
    Wake,
}

enum Job {
    Js { callback: v8::Global<v8::Function>, refed: bool },
    V8(v8::Task),
    Local(LocalTask),
}

#[derive(Default)]
struct Timers {
    next: u32,
    queue: BinaryHeap<Reverse<(Instant, u32)>>,
    live: HashMap<u32, Job>,
}

impl Timers {
    fn add(&mut self, at: Instant, job: Job) -> u32 {
        self.next = self.next.wrapping_add(1).max(1);
        let id = self.next;
        self.queue.push(Reverse((at, id)));
        self.live.insert(id, job);
        id
    }

    fn js(&mut self, id: u32) -> Option<&mut bool> {
        match self.live.get_mut(&id) {
            Some(Job::Js { refed, .. }) => Some(refed),
            _ => None,
        }
    }
}

type Hook = Rc<dyn Fn(&mut v8::PinScope)>;

type Rejection = (v8::Global<v8::Promise>, v8::Global<v8::Value>);

pub struct Loop {
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    local: RefCell<VecDeque<LocalTask>>,
    timers: RefCell<Timers>,
    ops: Arc<AtomicIsize>,
    refs: Cell<isize>,
    rejections: RefCell<Vec<Rejection>>,
    after_task: RefCell<Option<Hook>>,
    hook_owed: Cell<bool>,
    busy: Arc<AtomicU64>,
    reporter: RefCell<Option<v8::Global<v8::Function>>>,
    exit: Cell<Option<i32>>,
    started: Instant,
}

thread_local! {
    static LOOP: RefCell<Option<Rc<Loop>>> = const { RefCell::new(None) };
}

pub fn current() -> Rc<Loop> {
    LOOP.with(|l| l.borrow().clone()).expect("acde: no event loop on this thread")
}

impl Loop {
    pub fn sender(&self) -> Sender<Msg> {
        self.tx.clone()
    }

    pub fn spawner(&self) -> acde_napi::V8CrossThreadTaskSpawner {
        let tx = self.tx.clone();
        acde_napi::V8CrossThreadTaskSpawner::new(move |task| _ = tx.send(Msg::Task(task)))
    }

    pub fn ops(&self) -> acde_napi::ExternalOpsTracker {
        let (ops, tx) = (self.ops.clone(), self.tx.clone());
        acde_napi::ExternalOpsTracker::new(move |more| {
            if more {
                ops.fetch_add(1, Ordering::SeqCst);
            } else if ops.fetch_sub(1, Ordering::SeqCst) == 1 {
                _ = tx.send(Msg::Wake);
            }
        })
    }

    pub fn spawn_local(&self, task: impl FnOnce(&mut v8::PinScope) + 'static) {
        self.local.borrow_mut().push_back(Box::new(task));
    }

    pub fn keep_alive(&self, on: bool) {
        self.refs.set(self.refs.get() + if on { 1 } else { -1 });
    }

    pub fn set_after_task(&self, hook: impl Fn(&mut v8::PinScope) + 'static) {
        *self.after_task.borrow_mut() = Some(Rc::new(hook));
    }

    pub fn busy(&self) -> Arc<AtomicU64> {
        self.busy.clone()
    }

    fn mark_busy(&self) {
        self.busy.store(busy_stamp(), Ordering::Relaxed);
    }

    pub fn set_reporter(&self, reporter: Option<v8::Global<v8::Function>>) {
        *self.reporter.borrow_mut() = reporter;
    }

    pub fn exit(&self, code: i32) {
        self.exit.set(Some(code));
    }

    pub fn now(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    pub fn set_timer(&self, ms: f64, callback: v8::Global<v8::Function>, refed: bool) -> u32 {
        let at = Instant::now() + Duration::from_secs_f64(ms.max(0.0) / 1000.0);
        self.timers.borrow_mut().add(at, Job::Js { callback, refed })
    }

    pub fn delay(&self, after: Duration, task: impl FnOnce(&mut v8::PinScope) + 'static) {
        self.timers.borrow_mut().add(Instant::now() + after, Job::Local(Box::new(task)));
    }

    pub fn clear_timer(&self, id: u32) {
        let mut timers = self.timers.borrow_mut();
        if timers.js(id).is_some() {
            timers.live.remove(&id);
        }
    }

    pub fn ref_timer(&self, id: u32, refed: bool) {
        if let Some(on) = self.timers.borrow_mut().js(id) {
            *on = refed;
        }
    }

    fn due(&self, now: Instant) -> Option<Job> {
        let mut timers = self.timers.borrow_mut();
        while let Some(&Reverse((at, id))) = timers.queue.peek() {
            if at > now {
                return None;
            }
            timers.queue.pop();
            if let Some(job) = timers.live.remove(&id) {
                return Some(job);
            }
        }
        None
    }

    fn next_deadline(&self) -> Option<Instant> {
        let mut timers = self.timers.borrow_mut();
        while let Some(&Reverse((at, id))) = timers.queue.peek() {
            if timers.live.contains_key(&id) {
                return Some(at);
            }
            timers.queue.pop();
        }
        None
    }

    fn alive(&self) -> bool {
        self.refs.get() > 0
            || self.ops.load(Ordering::SeqCst) > 0
            || !self.local.borrow().is_empty()
            || self.timers.borrow().live.values().any(|job| matches!(job, Job::Js { refed: true, .. }))
    }
}

pub struct Runtime {
    pub context: v8::Global<v8::Context>,
    pub lp: Rc<Loop>,
    pub isolate: v8::OwnedIsolate,
}

impl Runtime {
    pub fn new(heap_mb: Option<usize>) -> Self {
        crate::engine::init();
        let mut params = v8::CreateParams::default();
        if let Some(mb) = heap_mb {
            params = params.heap_limits(0, mb * 1024 * 1024);
        }
        let mut isolate = v8::Isolate::new(params);
        isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
        isolate.set_promise_reject_callback(promise_reject);
        isolate.set_host_import_module_dynamically_callback(crate::modules::dynamic_import);
        isolate.set_host_initialize_import_meta_object_callback(crate::modules::import_meta);
        let (tx, rx) = channel();
        crate::engine::register(isolate_ptr(&mut isolate), tx.clone());
        let lp = Rc::new(Loop {
            tx,
            rx,
            local: Default::default(),
            timers: Default::default(),
            ops: Default::default(),
            refs: Cell::new(0),
            rejections: Default::default(),
            after_task: Default::default(),
            hook_owed: Cell::new(false),
            busy: Default::default(),
            reporter: Default::default(),
            exit: Cell::new(None),
            started: Instant::now(),
        });
        LOOP.with(|l| *l.borrow_mut() = Some(lp.clone()));
        let context = {
            v8::scope!(let scope, &mut isolate);
            let context = v8::Context::new(scope, Default::default());
            let scope = &mut v8::ContextScope::new(scope, context);
            crate::profile::start(scope, web_name());
            v8::Global::new(scope, context)
        };
        Runtime { context, lp, isolate }
    }

    pub fn task<R>(&mut self, f: impl FnOnce(&mut v8::PinScope) -> R) -> R {
        self.lp.mark_busy();
        v8::scope_with_context!(let scope, &mut self.isolate, &self.context);
        run_task(scope, f)
    }

    fn v8_task(&mut self, task: v8::Task) {
        self.lp.mark_busy();
        v8::scope_with_context!(let scope, &mut self.isolate, &self.context);
        let started = Instant::now();
        task.run();
        let ms = acde_log::since_ms(started);
        if ms >= LONG_TASK_MS {
            log::debug!(target: "perf::task", "{} v8 ms={ms:.3}", web_name());
        }
        if scope.is_execution_terminating() {
            return;
        }
        scope.perform_microtask_checkpoint();
        report_rejections(scope);
        self.lp.hook_owed.set(true);
    }

    fn before_wait(&mut self) {
        if !self.lp.hook_owed.get() {
            return;
        }
        v8::scope_with_context!(let scope, &mut self.isolate, &self.context);
        if scope.is_execution_terminating() {
            return;
        }
        after_task(scope);
    }

    pub fn run_until(&mut self, stop: impl Fn() -> bool) -> i32 {
        let lp = self.lp.clone();
        loop {
            if let Some(code) = lp.exit.get() {
                return code;
            }
            if stop() {
                return 1;
            }
            let now = Instant::now();
            while let Some(job) = lp.due(now) {
                match job {
                    Job::Js { callback, .. } => self.task(|scope| _ = crate::bind::call(scope, &callback, &[])),
                    Job::V8(task) => self.v8_task(task),
                    Job::Local(task) => self.task(task),
                }
                if lp.exit.get().is_some() {
                    break;
                }
            }
            let local: Vec<_> = lp.local.borrow_mut().drain(..).collect();
            for task in local {
                self.task(task);
            }
            while let Ok(msg) = lp.rx.try_recv() {
                self.message(msg);
            }
            if lp.exit.get().is_some() {
                continue;
            }
            if !lp.local.borrow().is_empty() {
                continue;
            }
            if stop() {
                return 1;
            }
            if !lp.alive() {
                return 0;
            }
            self.before_wait();
            if !lp.local.borrow().is_empty() || lp.exit.get().is_some() {
                continue;
            }
            lp.busy.store(0, Ordering::Relaxed);
            let wait = lp.next_deadline().map(|at| at.saturating_duration_since(Instant::now()));
            let msg = match wait {
                Some(wait) => match lp.rx.recv_timeout(wait) {
                    Ok(msg) => msg,
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => return 0,
                },
                None => match lp.rx.recv() {
                    Ok(msg) => msg,
                    Err(_) => return 0,
                },
            };
            self.message(msg);
        }
    }

    fn message(&mut self, msg: Msg) {
        match msg {
            Msg::Task(task) => self.task(task),
            Msg::V8(task) => self.v8_task(task),
            Msg::Delayed(at, task) => _ = self.lp.timers.borrow_mut().add(at, Job::V8(task)),
            Msg::Wake => {}
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        crate::profile::stop();
        crate::engine::unregister(isolate_ptr(&mut self.isolate));
        LOOP.with(|l| *l.borrow_mut() = None);
    }
}

fn isolate_ptr(isolate: &mut v8::Isolate) -> *mut std::ffi::c_void {
    unsafe { std::mem::transmute::<v8::UnsafeRawIsolatePtr, *mut std::ffi::c_void>(isolate.as_raw_isolate_ptr()) }
}

const LONG_TASK_MS: f64 = 8.0;

pub fn busy_stamp() -> u64 {
    acde_log::start().elapsed().as_millis() as u64 + 1
}

static WEB_NAME: OnceLock<String> = OnceLock::new();

pub fn set_web_name(name: &str) {
    _ = WEB_NAME.set(name.to_owned());
}

pub fn web_name() -> &'static str {
    WEB_NAME.get().map_or("broker", String::as_str)
}

fn run_task<R>(scope: &mut v8::PinScope, f: impl FnOnce(&mut v8::PinScope) -> R) -> R {
    let started = log::log_enabled!(target: "perf::task", log::Level::Debug).then(Instant::now);
    let result = {
        v8::tc_scope!(let tc, scope);
        let result = f(tc);
        if let Some(exception) = tc.exception().filter(|_| !tc.has_terminated()) {
            report(tc, exception);
        }
        result
    };
    if scope.is_execution_terminating() {
        return result;
    }
    scope.perform_microtask_checkpoint();
    report_rejections(scope);
    let hook = started.map(|_| Instant::now());
    after_task(scope);
    if let (Some(started), Some(hook)) = (started, hook) {
        let ms = acde_log::since_ms(started);
        if ms >= LONG_TASK_MS {
            log::debug!(target: "perf::task", "{} ms={ms:.3} hook={:.3}", web_name(), acde_log::since_ms(hook));
        }
    }
    result
}

fn report_rejections(scope: &mut v8::PinScope) {
    let lp = current();
    let rejections: Vec<_> = lp.rejections.borrow_mut().drain(..).collect();
    for (promise, reason) in rejections {
        let (promise, reason) = (v8::Local::new(scope, promise), v8::Local::new(scope, reason));
        report_to(scope, reason, Some(promise));
    }
}

fn after_task(scope: &mut v8::PinScope) {
    let lp = current();
    lp.hook_owed.set(false);
    let hook = lp.after_task.borrow().clone();
    if let Some(hook) = hook {
        let thrown = {
            v8::tc_scope!(let tc, scope);
            hook(tc);
            tc.exception().map(|e| v8::Global::new(tc, e))
        };
        if let Some(exception) = thrown {
            let exception = v8::Local::new(scope, exception);
            report(scope, exception);
        }
        scope.perform_microtask_checkpoint();
    }
}

pub fn report(scope: &mut v8::PinScope, error: v8::Local<v8::Value>) {
    report_to(scope, error, None);
}

fn report_to(scope: &mut v8::PinScope, error: v8::Local<v8::Value>, promise: Option<v8::Local<v8::Promise>>) {
    let lp = current();
    let reporter = lp.reporter.borrow().clone();
    if let Some(reporter) = reporter {
        v8::tc_scope!(let tc, scope);
        let args: Vec<v8::Local<v8::Value>> = match promise {
            Some(promise) => vec![error, promise.into()],
            None => vec![error],
        };
        if crate::bind::call(tc, &reporter, &args).is_some() {
            return;
        }
    }
    log::error!(target: "js", "uncaught: {}", describe(scope, error));
}

pub fn describe(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> String {
    if let Ok(object) = v8::Local::<v8::Object>::try_from(value) {
        let key = v8::String::new(scope, "stack").unwrap();
        if let Some(stack) = object.get(scope, key.into())
            && stack.is_string()
        {
            return stack.to_rust_string_lossy(scope);
        }
    }
    value.to_rust_string_lossy(scope)
}

extern "C" fn promise_reject(message: v8::PromiseRejectMessage) {
    v8::callback_scope!(unsafe scope, &message);
    let promise = message.get_promise();
    let lp = current();
    match message.get_event() {
        v8::PromiseRejectEvent::PromiseRejectWithNoHandler => {
            let reason = message.get_value().unwrap_or_else(|| v8::undefined(scope).into());
            let entry = (v8::Global::new(scope, promise), v8::Global::new(scope, reason));
            lp.rejections.borrow_mut().push(entry);
        }
        v8::PromiseRejectEvent::PromiseHandlerAddedAfterReject => {
            let promise = v8::Global::new(scope, promise);
            lp.rejections.borrow_mut().retain(|(p, _)| *p != promise);
        }
        _ => {}
    }
}
