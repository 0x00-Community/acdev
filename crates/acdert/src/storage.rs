use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::Arc;

use acde_storage::{Change, Lease, LocalArea, Place, Subscription, Text};

use crate::bind;
use crate::rt::{self, Msg};

struct State {
    lease: Lease,
    subscription: Subscription,
    on_change: Option<v8::Global<v8::Function>>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

pub fn place(scope: &mut v8::PinScope, wanted: v8::Local<v8::Object>) -> Option<Place> {
    let storage = bind::get(scope, wanted, "storage")?;
    let storage = v8::Local::<v8::Object>::try_from(storage).ok()?;
    let key = bind::get_string(scope, storage, "key")?;
    let path = |scope: &mut v8::PinScope, name: &str| {
        bind::get(scope, storage, name).filter(|v| v.is_string()).map(|v| PathBuf::from(v.to_rust_string_lossy(scope))).filter(|p| p.is_absolute())
    };
    let dir = path(scope, "dir");
    let legacy = path(scope, "legacy");
    Some(Place { key, dir, legacy })
}

pub fn install(scope: &mut v8::PinScope, natives: v8::Local<v8::Object>, place: Place) {
    let lease = Lease::open(place);
    let lease_clone = lease.clone();
    let caches_lease = lease.clone();
    let tx = rt::current().sender();
    let subscription = lease.local().subscribe(move |change| {
        let change = change.clone();
        _ = tx.send(Msg::Task(Box::new(move |scope| deliver(scope, change))));
    });
    STATE.with(|s| *s.borrow_mut() = Some(State { lease, subscription, on_change: None }));
    let local = v8::Object::new(scope);
    crate::methods!(scope, local,
        "length" => length,
        "key" => key,
        "get" => get,
        "set" => set,
        "remove" => remove,
        "clear" => clear_area,
        "keys" => keys,
    );
    let storage = v8::Object::new(scope);
    bind::set(scope, storage, "local", local.into());
    crate::idb::install(scope, storage, lease_clone);
    crate::caches::install(scope, storage, caches_lease);
    let cookies = v8::Object::new(scope);
    crate::methods!(scope, cookies,
        "set" => set_cookie,
        "matching" => matching_cookies,
    );
    bind::set(scope, storage, "cookies", cookies.into());
    crate::methods!(scope, storage,
        "onChange" => on_change,
        "estimate" => estimate,
        "privateDirectory" => private_directory,
    );
    bind::set(scope, natives, "storage", storage.into());
}

pub fn clear() {
    let state = STATE.with(|s| s.borrow_mut().take());
    drop(state);
}

fn with_local<R>(scope: &mut v8::PinScope, f: impl FnOnce(&Arc<LocalArea>, u64) -> R) -> Option<R> {
    let found = STATE.with(|s| s.borrow().as_ref().map(|s| (s.lease.local().clone(), s.subscription.id())));
    let Some((area, source)) = found else {
        bind::throw_error(scope, "storage: released");
        return None;
    };
    Some(f(&area, source))
}

fn utf16(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Text {
    let Some(text) = value.to_string(scope) else { return Text::default() };
    let mut units = vec![0u16; text.length()];
    text.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
    units.into()
}

fn js_text<'s>(scope: &mut v8::PinScope<'s, '_>, text: Option<&[u16]>) -> v8::Local<'s, v8::Value> {
    match text.and_then(|t| v8::String::new_from_two_byte(scope, t, v8::NewStringType::Normal)) {
        Some(s) => s.into(),
        None => v8::null(scope).into(),
    }
}

fn length(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    if let Some(n) = with_local(scope, |area, _| area.len()) {
        rv.set(v8::Number::new(scope, n as f64).into());
    }
}

fn key(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let index = args.get(0).number_value(scope).unwrap_or(f64::NAN);
    if !(0.0..usize::MAX as f64).contains(&index) {
        return rv.set(v8::null(scope).into());
    }
    if let Some(key) = with_local(scope, |area, _| area.key(index as usize)) {
        let value = js_text(scope, key.as_deref());
        rv.set(value);
    }
}

fn get(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let key = utf16(scope, args.get(0));
    if let Some(value) = with_local(scope, |area, _| area.get(&key)) {
        let value = js_text(scope, value.as_deref());
        rv.set(value);
    }
}

fn set(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let key = utf16(scope, args.get(0));
    let value = utf16(scope, args.get(1));
    let url = bind::arg_string(scope, &args, 2);
    if let Some(done) = with_local(scope, |area, source| area.set(key, value, source, &url)) {
        rv.set(v8::Boolean::new(scope, done.is_ok()).into());
    }
}

fn remove(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let key = utf16(scope, args.get(0));
    let url = bind::arg_string(scope, &args, 1);
    with_local(scope, |area, source| area.remove(&key, source, &url));
}

fn clear_area(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let url = bind::arg_string(scope, &args, 0);
    with_local(scope, |area, source| area.clear(source, &url));
}

fn keys(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(keys) = with_local(scope, |area, _| area.keys()) else { return };
    let list: Vec<v8::Local<v8::Value>> = keys.iter().map(|k| js_text(scope, Some(k))).collect();
    rv.set(v8::Array::new_with_elements(scope, &list).into());
}

fn on_change(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let callback = v8::Local::<v8::Function>::try_from(args.get(0)).ok().map(|f| v8::Global::new(scope, f));
    STATE.with(|s| {
        if let Some(state) = s.borrow_mut().as_mut() {
            state.on_change = callback;
        }
    });
}

fn deliver(scope: &mut v8::PinScope, change: Change) {
    let Some(callback) = STATE.with(|s| s.borrow().as_ref().and_then(|s| s.on_change.clone())) else { return };
    let args = [
        js_text(scope, change.key.as_deref()),
        js_text(scope, change.old.as_deref()),
        js_text(scope, change.new.as_deref()),
        bind::string(scope, &change.url).into(),
    ];
    bind::call(scope, &callback, &args);
}

fn with_jar<R>(scope: &mut v8::PinScope, f: impl FnOnce(&acde_storage::CookieJar) -> R) -> Option<R> {
    let jar = STATE.with(|s| s.borrow().as_ref().map(|s| s.lease.cookies().clone()));
    let Some(jar) = jar else {
        bind::throw_error(scope, "storage: released");
        return None;
    };
    Some(f(&jar))
}

fn set_cookie(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let name = bind::arg_string(scope, &args, 0);
    let value = bind::arg_string(scope, &args, 1);
    let path = bind::arg_string(scope, &args, 2);
    let expires = args.get(3).number_value(scope).filter(|_| !args.get(3).is_null_or_undefined());
    let http_only = args.get(4).boolean_value(scope);
    let from_script = args.get(5).boolean_value(scope);
    let cookie = acde_storage::NewCookie { name: &name, value: &value, path: &path, expires, http_only, from_script };
    with_jar(scope, |jar| jar.set(cookie, acde_storage::now_ms()));
}

fn matching_cookies(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let path = bind::arg_string(scope, &args, 0);
    let script = args.get(1).boolean_value(scope);
    let Some(found) = with_jar(scope, |jar| jar.matching(&path, script, acde_storage::now_ms())) else { return };
    let items: Vec<v8::Local<v8::Value>> = found
        .iter()
        .map(|(name, value)| {
            let pair = [bind::string(scope, name).into(), bind::string(scope, value).into()];
            v8::Array::new_with_elements(scope, &pair).into()
        })
        .collect();
    rv.set(v8::Array::new_with_elements(scope, &items).into());
}

fn lease(scope: &mut v8::PinScope) -> Option<Lease> {
    let lease = STATE.with(|s| s.borrow().as_ref().map(|s| s.lease.clone()));
    if lease.is_none() {
        bind::throw_error(scope, "storage: released");
    }
    lease
}

fn estimate(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(lease) = lease(scope) else { return };
    crate::offload::run(
        scope,
        &mut rv,
        "acde-storage-estimate",
        move || lease.estimate(),
        |scope, resolver, (usage, quota)| {
            let value = crate::js_object!(scope, {"usage" => usage as f64, "quota" => quota as f64});
            resolver.resolve(scope, value.into());
        },
    );
}

fn private_directory(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(lease) = lease(scope) else { return };
    let dir = lease.files_dir().join("opfs");
    let made = {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&dir)
    };
    if let Err(e) = made {
        log::warn!("storage: the private folder {} cannot be made: {e}", dir.display());
        return bind::throw_error(scope, "UnknownError: the private folder cannot be made");
    }
    match crate::picker::adopt(&dir.to_string_lossy()) {
        Ok(path) => rv.set(bind::string(scope, &path).into()),
        Err(e) => {
            log::warn!("storage: the private folder {} cannot be opened: {e}", dir.display());
            bind::throw_error(scope, "UnknownError: the private folder cannot be opened");
        }
    }
}
