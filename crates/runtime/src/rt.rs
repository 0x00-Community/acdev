use std::future::Future;
use std::sync::OnceLock;

use futures_util::future::{AbortHandle, Abortable};

static HANDLE: OnceLock<ntex::rt::Handle> = OnceLock::new();

fn handle() -> &'static ntex::rt::Handle {
    HANDLE.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let started = std::thread::Builder::new().name("acde-rt".into()).spawn(move || {
            let ran = ntex::rt::System::build().name("acde-rt").build(ntex::rt::DefaultRuntime).run(move || {
                _ = tx.send(ntex::rt::Handle::current());
                Ok(())
            });
            if let Err(error) = ran {
                log::error!("the executor stopped: {error}");
            }
        });
        if let Err(error) = started {
            panic!("acde runtime: cannot start the executor thread: {error}");
        }
        rx.recv().unwrap_or_else(|_| panic!("acde runtime: the executor did not start"))
    })
}

async fn contained<F: Future>(fut: F) -> Option<F::Output> {
    use futures_util::FutureExt;
    match std::panic::AssertUnwindSafe(fut).catch_unwind().await {
        Ok(output) => Some(output),
        Err(panic) => {
            let message = panic.downcast_ref::<&str>().copied().or_else(|| panic.downcast_ref::<String>().map(String::as_str));
            log::error!("a task panicked: {}", message.unwrap_or("(no message)"));
            None
        }
    }
}

pub(crate) fn spawn<F>(fut: F)
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    handle().spawn(contained(fut)).detach();
}

pub(crate) struct Task(futures_util::future::AbortHandle);

impl Task {
    pub(crate) fn abort(&self) {
        self.0.abort();
    }
}

pub(crate) fn spawn_abortable<F>(fut: F) -> Task
where
    F: Future<Output = ()> + Send + 'static,
{
    let (fut, abort) = futures_util::future::abortable(fut);
    spawn(fut);
    Task(abort)
}

pub(crate) fn block_on<F>(fut: F) -> Option<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    spawn(async move {
        _ = tx.send(fut.await);
    });
    rx.recv().ok()
}

pub(crate) async fn local<F>(make: impl FnOnce() -> F + Send + 'static) -> Option<F::Output>
where
    F: Future + 'static,
    F::Output: Send + 'static,
{
    struct Stop(AbortHandle);
    impl Drop for Stop {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let (abort, registration) = AbortHandle::new_pair();
    let _stop = Stop(abort);
    let (tx, rx) = async_channel::bounded(1);
    ntex::rt::spawn(contained(async move {
        if let Ok(output) = Abortable::new(make(), registration).await {
            _ = tx.try_send(output);
        }
    }))
    .detach();
    rx.recv().await.ok()
}

pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, ntex::rt::BlockingError> {
    ntex::rt::spawn_blocking(work).await
}

#[cfg(not(test))]
mod backend {
    use super::handle;
    use napi::bindgen_prelude::{AsyncRuntime, AsyncRuntimeRejection, AsyncRuntimeTask};
    use std::future::Future;
    use std::pin::Pin;

    struct Backend;

    unsafe impl AsyncRuntime for Backend {
        fn spawn(&self, task: AsyncRuntimeTask) -> Result<(), AsyncRuntimeRejection<AsyncRuntimeTask>> {
            handle().spawn(task).detach();
            Ok(())
        }

        fn block_on(&self, future: Pin<&mut dyn Future<Output = ()>>) -> napi::Result<()> {
            futures_lite::future::block_on(future);
            Ok(())
        }

        fn shutdown(&self) -> napi::Result<()> {
            Ok(())
        }
    }

    #[napi_derive::module_init]
    fn register() {
        napi::bindgen_prelude::register_async_runtime(Backend);
    }
}
