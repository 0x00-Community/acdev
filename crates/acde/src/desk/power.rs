use std::sync::{Arc, Weak};

use acde_model::Scope;

use super::Desk;

const POWER_KEY: &str = "XF86PowerOff";

struct Screens(Weak<Desk>);

impl acde_runtime::PowerHost for Screens {
    fn set_idle(&self, timeouts: &[u32]) -> Result<(), String> {
        self.0.upgrade().ok_or("the desk is closed")?.link().set_idle(timeouts)
    }

    fn set_screens(&self, on: bool) {
        if let Some(desk) = self.0.upgrade() {
            desk.link().set_screens(on);
        }
    }
}

impl Desk {
    pub(super) fn power(&self) -> acde_runtime::Power {
        self.system.lock().unwrap_or_else(|e| e.into_inner()).power.clone()
    }

    /// The session's power policy (AGENTS.md「电源和电池」): idle, lid, power button and battery levels, as PowerDevil does.
    pub fn start_power(self: &Arc<Self>) {
        let power = self.power();
        if power.running() {
            return;
        }
        if let Err(e) = self.link().shortcut(POWER_KEY.to_owned(), Scope::Session, 0) {
            log::warn!("电源键: {e}");
        }
        if let Err(e) = power.start_policy(Screens(Arc::downgrade(self))) {
            log::warn!("电源策略: {e}");
        }
    }

    pub(super) fn power_key(&self, key: &str, scope: Option<Scope>) -> bool {
        if scope != Some(Scope::Session) || !key.eq_ignore_ascii_case(POWER_KEY) {
            return false;
        }
        let power = self.power();
        if power.running() {
            power.power_button();
        }
        true
    }
}
