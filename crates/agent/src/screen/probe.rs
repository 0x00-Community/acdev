use acde_wire::acompositor::desktop::acompositor_hit_v1::{self, AcompositorHitV1};
use acde_wire::acompositor::desktop::acompositor_render_state_v1::{self, AcompositorRenderStateV1, Composer, Drawn};
use serde_json::{Value, json};
use wayland_client::{Connection, Dispatch, Proxy, QueueHandle, WEnum};

use super::{State, Worker};

const PROBE_SINCE: u32 = 12;

#[derive(Default)]
pub(super) struct Probe {
    backend: Value,
    areas: Vec<Value>,
    landed: Value,
    beneath: Vec<u32>,
    done: bool,
}

impl Worker {
    pub(super) fn render_state(&mut self) -> Result<Value, String> {
        self.probing()?;
        let asked = self.globals.desktop.render_state(&self.qh, ());
        let waited = self.wait(|s| s.probe.done);
        asked.destroy();
        waited?;
        let Probe { mut backend, areas, .. } = std::mem::take(&mut self.state.probe);
        backend["areas"] = Value::Array(areas);
        Ok(backend)
    }

    pub(super) fn hit(&mut self, x: f64, y: f64) -> Result<Value, String> {
        self.probing()?;
        let asked = self.globals.desktop.hit(x, y, &self.qh, ());
        let waited = self.wait(|s| s.probe.done);
        asked.destroy();
        waited?;
        let Probe { mut landed, beneath, .. } = std::mem::take(&mut self.state.probe);
        landed["beneath"] = json!(beneath);
        Ok(landed)
    }

    fn probing(&mut self) -> Result<(), String> {
        let version = self.globals.desktop.version();
        if version < PROBE_SINCE {
            return Err(format!("acompositor answers no render state or hit (acompositor_desktop_v1 {version} below {PROBE_SINCE})"));
        }
        self.state.probe = Probe::default();
        Ok(())
    }
}

fn composer(given: WEnum<Composer>) -> &'static str {
    match given {
        WEnum::Value(Composer::Gpu) => "gpu",
        _ => "cpu",
    }
}

fn drawn(given: WEnum<Drawn>) -> &'static str {
    match given {
        WEnum::Value(Drawn::Frost) => "frost",
        WEnum::Value(Drawn::GpuGlass) => "gpu-glass",
        WEnum::Value(Drawn::CpuGlassFrosted) => "cpu-glass-frosted",
        _ => "none",
    }
}

impl Dispatch<AcompositorRenderStateV1, ()> for State {
    fn event(state: &mut Self, _: &AcompositorRenderStateV1, event: acompositor_render_state_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        use acompositor_render_state_v1::Event as E;
        let probe = &mut state.probe;
        match event {
            E::Backend { composer: c, device, driver } => probe.backend = json!({ "composer": composer(c), "device": device, "driver": driver }),
            E::Area { window, surface, x, y, width, height, drawn: d } => {
                probe.areas.push(json!({ "window": window, "surface": surface, "rect": [x, y, width, height], "drawn": drawn(d) }));
            }
            E::Done => probe.done = true,
            _ => {}
        }
    }
}

impl Dispatch<AcompositorHitV1, ()> for State {
    fn event(state: &mut Self, _: &AcompositorHitV1, event: acompositor_hit_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        use acompositor_hit_v1::Event as E;
        let probe = &mut state.probe;
        match event {
            E::Landed { window, role, surface, sx, sy } => probe.landed = json!({ "window": window, "role": role, "surface": surface, "local": [sx, sy] }),
            E::Beneath { window } => probe.beneath.push(window),
            E::Done => probe.done = true,
            _ => {}
        }
    }
}
