mod doubao;
mod mic;

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::Unknown;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Env, Result};
use napi_derive::napi;
use serde_json::Value;

use crate::runtime::js::JsFn;
use crate::runtime::sync::Locked;

enum Ctl {
    Finish,
    Cancel,
}

#[derive(Default)]
struct Current {
    id: u32,
    ctl: Option<async_channel::Sender<Ctl>>,
}

#[napi]
pub struct Voice {
    current: Arc<Mutex<Current>>,
}

#[napi]
impl Voice {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Self { current: Arc::default() }
    }

    #[napi(ts_args_type = "onEvent: (event: { type: 'partial', text: string } | { type: 'final', text: string } | { type: 'error', message: string }) => void")]
    pub fn listen(&self, env: Env, on_event: Unknown) -> Result<u32> {
        let sink: Arc<JsFn<Value>> = Arc::new(JsFn::new(&env, on_event)?);
        let (tx, rx) = async_channel::unbounded();
        let id = {
            let mut current = self.current.locked();
            if let Some(old) = current.ctl.replace(tx)
                && old.try_send(Ctl::Cancel).is_ok()
            {
                log::info!("voice #{}: cancelled by a new recording", current.id);
            }
            current.id = current.id.wrapping_add(1);
            current.id
        };
        log::info!("voice #{id}: recording");
        let current = self.current.clone();
        crate::runtime::rt::spawn(async move {
            crate::runtime::rt::local(move || doubao::run(id, rx, move |event| sink.notify(event, ThreadsafeFunctionCallMode::NonBlocking))).await;
            let mut current = current.locked();
            if current.id == id {
                current.ctl = None;
            }
        });
        Ok(id)
    }

    #[napi]
    pub fn stop(&self, id: u32) -> bool {
        let current = self.current.locked();
        let stopped = current.id == id && current.ctl.as_ref().is_some_and(|tx| tx.try_send(Ctl::Finish).is_ok());
        if stopped {
            log::info!("voice #{id}: stopped recording, waiting for the result");
        } else {
            log::info!("voice #{id}: stop requested, but it already ended (current #{})", current.id);
        }
        stopped
    }
}
