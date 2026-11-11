use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use smithay::backend::input::AxisSource;
use smithay::input::keyboard::XkbConfig;
use smithay::reexports::input::{self as libinput, AccelProfile, ClickMethod, DeviceCapability, Led, ScrollMethod, TapButtonMap};

use super::{Compositor, ShellEvent};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InputConfig {
    pub keyboard: Keyboard,
    pub mouse: Pointer,
    pub touchpad: Pointer,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Layout {
    pub layout: String,
    pub variant: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum NumLock {
    On,
    Off,
    #[default]
    Unchanged,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Keyboard {
    pub layouts: Vec<Layout>,
    pub model: String,
    pub options: Vec<String>,
    pub repeat: bool,
    pub repeat_delay: u32,
    pub repeat_rate: f64,
    pub numlock: NumLock,
}

impl Default for Keyboard {
    fn default() -> Self {
        Self { layouts: Vec::new(), model: String::new(), options: Vec::new(), repeat: true, repeat_delay: 600, repeat_rate: 25.0, numlock: NumLock::Unchanged }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Accel {
    Adaptive,
    Flat,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TapButtons {
    Lrm,
    Lmr,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Scroll {
    TwoFinger,
    Edge,
    Button,
    None,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Click {
    Areas,
    Fingers,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Pointer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acceleration: Option<Accel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_handed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub natural_scroll: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll_speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub middle_emulation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tap_to_click: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tap_and_drag: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drag_lock: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tap_buttons: Option<TapButtons>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disable_while_typing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll: Option<Scroll>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub click: Option<Click>,
}

impl Pointer {
    fn or(&self, base: &Pointer) -> Pointer {
        Pointer {
            speed: self.speed.or(base.speed),
            acceleration: self.acceleration.or(base.acceleration),
            left_handed: self.left_handed.or(base.left_handed),
            natural_scroll: self.natural_scroll.or(base.natural_scroll),
            scroll_speed: self.scroll_speed.or(base.scroll_speed),
            middle_emulation: self.middle_emulation.or(base.middle_emulation),
            tap_to_click: self.tap_to_click.or(base.tap_to_click),
            tap_and_drag: self.tap_and_drag.or(base.tap_and_drag),
            drag_lock: self.drag_lock.or(base.drag_lock),
            tap_buttons: self.tap_buttons.or(base.tap_buttons),
            disable_while_typing: self.disable_while_typing.or(base.disable_while_typing),
            scroll: self.scroll.or(base.scroll),
            click: self.click.or(base.click),
        }
    }

    fn fallback(touchpad: bool) -> Pointer {
        Pointer {
            speed: Some(0.0),
            acceleration: Some(Accel::Adaptive),
            left_handed: Some(false),
            natural_scroll: Some(false),
            scroll_speed: Some(1.0),
            middle_emulation: Some(false),
            tap_to_click: Some(touchpad),
            tap_and_drag: Some(true),
            drag_lock: Some(false),
            tap_buttons: Some(TapButtons::Lrm),
            disable_while_typing: Some(true),
            scroll: Some(if touchpad { Scroll::TwoFinger } else { Scroll::None }),
            click: Some(Click::Areas),
        }
    }

    fn clamp(&mut self) {
        self.speed = self.speed.map(|s| s.clamp(-1.0, 1.0));
        self.scroll_speed = self.scroll_speed.map(|s| s.clamp(0.1, 20.0));
    }
}

impl InputConfig {
    const LAYOUTS: usize = 4;

    pub fn patched(&self, patch: &Value) -> Result<Self, String> {
        let mut value = serde_json::to_value(self).map_err(|e| e.to_string())?;
        merge(&mut value, patch);
        let mut next: Self = serde_json::from_value(value).map_err(|e| format!("输入设置: {e}"))?;
        next.check()?;
        Ok(next)
    }

    fn check(&mut self) -> Result<(), String> {
        let name = |s: &str| s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b));
        let k = &mut self.keyboard;
        k.layouts.retain(|l| !l.layout.is_empty());
        if k.layouts.len() > Self::LAYOUTS {
            return Err(format!("最多 {} 个键盘布局", Self::LAYOUTS));
        }
        if let Some(bad) = k.layouts.iter().find(|l| !name(&l.layout) || !name(&l.variant)) {
            return Err(format!("不认识的键盘布局 {:?}({:?})", bad.layout, bad.variant));
        }
        if !name(&k.model) {
            return Err(format!("不认识的键盘型号 {:?}", k.model));
        }
        k.options.retain(|o| !o.is_empty());
        k.options.dedup();
        if let Some(bad) = k.options.iter().find(|o| !o.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-:+".contains(&b))) {
            return Err(format!("不认识的键盘选项 {bad:?}"));
        }
        k.repeat_delay = k.repeat_delay.clamp(100, 5000);
        k.repeat_rate = if k.repeat_rate.is_finite() { k.repeat_rate.clamp(0.2, 100.0) } else { 25.0 };
        self.mouse.clamp();
        self.touchpad.clamp();
        Ok(())
    }

    fn path() -> Option<PathBuf> {
        let config = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
        Some(config.join("acde").join("input.json"))
    }

    pub fn load() -> Self {
        let Some(path) = Self::path() else { return Self::default() };
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Self::default(),
            Err(e) => {
                log::warn!("{}: {e}", path.display());
                return Self::default();
            }
        };
        let parsed = serde_json::from_str::<Self>(&text).map_err(|e| e.to_string()).and_then(|mut c| c.check().map(|()| c));
        parsed.unwrap_or_else(|e| {
            log::warn!("{}: {e}, 用默认的输入设置", path.display());
            Self::default()
        })
    }

    fn save(&self) -> Result<(), String> {
        let path = Self::path().ok_or("没有 XDG_CONFIG_HOME 也没有 HOME")?;
        let dir = path.parent().ok_or("输入设置的目录")?;
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text + "\n").map_err(|e| format!("{}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn xkb(&self) -> Xkb {
        let k = &self.keyboard;
        let join = |f: fn(&Layout) -> &str| k.layouts.iter().map(f).collect::<Vec<_>>().join(",");
        let variant = join(|l| l.variant.as_str());
        Xkb {
            model: k.model.clone(),
            layout: join(|l| l.layout.as_str()),
            variant: if variant.chars().all(|c| c == ',') { String::new() } else { variant },
            options: (!k.options.is_empty()).then(|| k.options.join(",")),
        }
    }

    /// Wayland's repeat_info: rate per second (0 is no repeat) and delay in ms.
    pub fn repeat(&self) -> (i32, i32) {
        let k = &self.keyboard;
        let rate = if k.repeat { k.repeat_rate.round().max(1.0) as i32 } else { 0 };
        (rate, k.repeat_delay as i32)
    }
}

fn merge(into: &mut Value, patch: &Value) {
    match (into, patch) {
        (Value::Object(into), Value::Object(patch)) => {
            for (key, value) in patch {
                if value.is_null() {
                    into.remove(key);
                } else {
                    merge(into.entry(key.clone()).or_insert(Value::Null), value);
                }
            }
        }
        (into, patch) => *into = patch.clone(),
    }
}

#[derive(PartialEq, Clone, Default, Debug)]
pub struct Xkb {
    model: String,
    layout: String,
    variant: String,
    options: Option<String>,
}

impl Xkb {
    pub fn config(&self) -> XkbConfig<'_> {
        XkbConfig { rules: "", model: &self.model, layout: &self.layout, variant: &self.variant, options: self.options.clone() }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Keyboard,
    Mouse,
    Touchpad,
    Other,
}

struct Device {
    handle: libinput::Device,
    kind: Kind,
    keyboard: bool,
    defaults: Pointer,
    scrolls: Vec<Scroll>,
    clicks: Vec<Click>,
}

impl Device {
    fn new(handle: libinput::Device) -> Self {
        let pointer = handle.has_capability(DeviceCapability::Pointer);
        let keyboard = handle.has_capability(DeviceCapability::Keyboard);
        let other = handle.has_capability(DeviceCapability::TabletTool) || handle.has_capability(DeviceCapability::Touch) || handle.has_capability(DeviceCapability::Gesture) && !pointer;
        let touchpad = pointer && handle.config_tap_finger_count() > 0;
        let kind = match (pointer, touchpad, keyboard) {
            (true, true, _) => Kind::Touchpad,
            (true, false, _) if !other => Kind::Mouse,
            (false, _, true) => Kind::Keyboard,
            _ => Kind::Other,
        };
        let read = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Self::read(&handle, kind == Kind::Touchpad)));
        let (defaults, scrolls, clicks) = read.unwrap_or_else(|_| {
            log::warn!("读输入设备 {} 的默认设置失败", handle.name());
            (Pointer::default(), Vec::new(), Vec::new())
        });
        Self { handle, kind, keyboard, defaults, scrolls, clicks }
    }

    fn read(d: &libinput::Device, touchpad: bool) -> (Pointer, Vec<Scroll>, Vec<Click>) {
        let scroll = |m: ScrollMethod| match m {
            ScrollMethod::TwoFinger => Some(Scroll::TwoFinger),
            ScrollMethod::Edge => Some(Scroll::Edge),
            ScrollMethod::OnButtonDown => Some(Scroll::Button),
            ScrollMethod::NoScroll => Some(Scroll::None),
            _ => None,
        };
        let click = |m: ClickMethod| match m {
            ClickMethod::ButtonAreas => Some(Click::Areas),
            ClickMethod::Clickfinger => Some(Click::Fingers),
            _ => None,
        };
        let defaults = Pointer {
            speed: d.config_accel_is_available().then(|| d.config_accel_default_speed()),
            acceleration: d.config_accel_default_profile().and_then(|p| match p {
                AccelProfile::Flat => Some(Accel::Flat),
                AccelProfile::Adaptive => Some(Accel::Adaptive),
                _ => None,
            }),
            left_handed: d.config_left_handed_is_available().then(|| d.config_left_handed_default()),
            natural_scroll: d.config_scroll_has_natural_scroll().then(|| d.config_scroll_default_natural_scroll_enabled()),
            scroll_speed: None,
            middle_emulation: d.config_middle_emulation_is_available().then(|| d.config_middle_emulation_default_enabled()),
            tap_to_click: touchpad.then_some(true),
            tap_and_drag: touchpad.then(|| d.config_tap_default_drag_enabled()),
            drag_lock: None,
            tap_buttons: d.config_tap_default_button_map().map(|m| match m {
                TapButtonMap::LeftMiddleRight => TapButtons::Lmr,
                _ => TapButtons::Lrm,
            }),
            disable_while_typing: d.config_dwt_is_available().then(|| d.config_dwt_default_enabled()),
            scroll: d.config_scroll_default_method().and_then(scroll),
            click: d.config_click_default_method().and_then(click),
        };
        let scrolls = d.config_scroll_methods().into_iter().filter_map(scroll).collect();
        let clicks = d.config_click_methods().into_iter().filter_map(click).collect();
        (defaults, scrolls, clicks)
    }

    fn apply(&mut self, config: &InputConfig) {
        let (wanted, touchpad) = match self.kind {
            Kind::Mouse => (&config.mouse, false),
            Kind::Touchpad => (&config.touchpad, true),
            Kind::Keyboard | Kind::Other => return,
        };
        let p = wanted.or(&self.defaults);
        let name = self.handle.name().to_owned();
        let d = &mut self.handle;
        let mut results = Vec::new();
        if let Some(speed) = p.speed.filter(|_| d.config_accel_is_available()) {
            results.push(("speed", d.config_accel_set_speed(speed)));
        }
        if let Some(a) = p.acceleration.filter(|_| d.config_accel_is_available()) {
            results.push(("acceleration", d.config_accel_set_profile(if a == Accel::Flat { AccelProfile::Flat } else { AccelProfile::Adaptive })));
        }
        if let Some(on) = p.left_handed.filter(|_| d.config_left_handed_is_available()) {
            results.push(("leftHanded", d.config_left_handed_set(on)));
        }
        if let Some(on) = p.natural_scroll.filter(|_| d.config_scroll_has_natural_scroll()) {
            results.push(("naturalScroll", d.config_scroll_set_natural_scroll_enabled(on)));
        }
        if let Some(on) = p.middle_emulation.filter(|_| d.config_middle_emulation_is_available()) {
            results.push(("middleEmulation", d.config_middle_emulation_set_enabled(on)));
        }
        if touchpad && d.config_tap_finger_count() > 0 {
            if let Some(on) = p.tap_to_click {
                results.push(("tapToClick", d.config_tap_set_enabled(on)));
            }
            if let Some(on) = p.tap_and_drag {
                results.push(("tapAndDrag", d.config_tap_set_drag_enabled(on)));
            }
            if let Some(on) = p.drag_lock {
                results.push(("dragLock", d.config_tap_set_drag_lock_enabled(on)));
            }
            if let Some(map) = p.tap_buttons {
                results.push(("tapButtons", d.config_tap_set_button_map(if map == TapButtons::Lmr { TapButtonMap::LeftMiddleRight } else { TapButtonMap::LeftRightMiddle })));
            }
        }
        if let Some(on) = p.disable_while_typing.filter(|_| d.config_dwt_is_available()) {
            results.push(("disableWhileTyping", d.config_dwt_set_enabled(on)));
        }
        if let Some(s) = p.scroll.filter(|s| self.scrolls.contains(s)) {
            let method = match s {
                Scroll::TwoFinger => ScrollMethod::TwoFinger,
                Scroll::Edge => ScrollMethod::Edge,
                Scroll::Button => ScrollMethod::OnButtonDown,
                Scroll::None => ScrollMethod::NoScroll,
            };
            results.push(("scroll", d.config_scroll_set_method(method)));
        }
        if let Some(c) = p.click.filter(|c| self.clicks.contains(c)) {
            results.push(("click", d.config_click_set_method(if c == Click::Fingers { ClickMethod::Clickfinger } else { ClickMethod::ButtonAreas })));
        }
        for (what, result) in results {
            if let Err(e) = result {
                log::debug!("输入设备 {name}: {what}: {e:?}");
            }
        }
    }
}

/// The input settings the compositor applies (KDE's kxkbrc / kcminputrc as one file) and the libinput devices it applies them to.
pub struct Inputs {
    pub config: InputConfig,
    devices: Vec<Device>,
    layouts: Vec<String>,
    current: u32,
    leds: Led,
}

impl Inputs {
    pub fn new(config: InputConfig) -> Self {
        Self { config, devices: Vec::new(), layouts: Vec::new(), current: 0, leds: Led::empty() }
    }

    fn pointer_state(&self, kind: Kind, wanted: &Pointer) -> Value {
        let mut found = self.devices.iter().filter(|d| d.kind == kind);
        let first = found.next();
        let base = first.map(|d| d.defaults.or(&Pointer::fallback(kind == Kind::Touchpad))).unwrap_or_else(|| Pointer::fallback(kind == Kind::Touchpad));
        let mut value = serde_json::to_value(wanted.or(&base)).unwrap_or_default();
        if let Value::Object(map) = &mut value {
            map.insert("present".into(), first.is_some().into());
            if kind == Kind::Touchpad {
                let all = || self.devices.iter().filter(|d| d.kind == Kind::Touchpad);
                let mut scrolls: Vec<Scroll> = all().flat_map(|d| d.scrolls.iter().copied()).collect();
                scrolls.dedup();
                let mut clicks: Vec<Click> = all().flat_map(|d| d.clicks.iter().copied()).collect();
                clicks.dedup();
                map.insert("scrollMethods".into(), serde_json::to_value(scrolls).unwrap_or_default());
                map.insert("clickMethods".into(), serde_json::to_value(clicks).unwrap_or_default());
            } else {
                for key in ["tapToClick", "tapAndDrag", "dragLock", "tapButtons", "disableWhileTyping", "scroll", "click"] {
                    map.remove(key);
                }
            }
        }
        value
    }

    pub fn state(&self) -> Value {
        let mut keyboard = serde_json::to_value(&self.config.keyboard).unwrap_or_default();
        if let Value::Object(map) = &mut keyboard {
            map.insert("active".into(), self.layouts.clone().into());
            map.insert("current".into(), self.current.into());
        }
        let devices: Vec<Value> = self
            .devices
            .iter()
            .filter(|d| matches!(d.kind, Kind::Mouse | Kind::Touchpad))
            .map(|d| json!({ "name": d.handle.name(), "kind": if d.kind == Kind::Touchpad { "touchpad" } else { "mouse" } }))
            .collect();
        let mut out = Map::new();
        out.insert("keyboard".into(), keyboard);
        out.insert("mouse".into(), self.pointer_state(Kind::Mouse, &self.config.mouse));
        out.insert("touchpad".into(), self.pointer_state(Kind::Touchpad, &self.config.touchpad));
        out.insert("devices".into(), devices.into());
        Value::Object(out)
    }

    /// The scroll speed (KDE's ScrollFactor) for a scroll event: the touchpad's for finger scrolling, the mouse's otherwise.
    pub fn scroll_factor(&self, source: AxisSource) -> f64 {
        let p = if source == AxisSource::Finger { &self.config.touchpad } else { &self.config.mouse };
        p.scroll_speed.unwrap_or(1.0)
    }
}

impl Compositor {
    pub fn input_device_added(&mut self, handle: libinput::Device) {
        let mut device = Device::new(handle);
        log::info!("输入设备 {}: {:?}", device.handle.name(), device.kind);
        device.apply(&self.inputs.config);
        if device.keyboard {
            device.handle.led_update(self.inputs.leds);
        }
        let shown = matches!(device.kind, Kind::Mouse | Kind::Touchpad);
        self.inputs.devices.push(device);
        if shown {
            self.emit_input();
        }
    }

    pub fn input_device_removed(&mut self, handle: &libinput::Device) {
        let Some(at) = self.inputs.devices.iter().position(|d| d.handle == *handle) else { return };
        let device = self.inputs.devices.remove(at);
        if matches!(device.kind, Kind::Mouse | Kind::Touchpad) {
            self.emit_input();
        }
    }

    pub fn input_leds(&mut self, num: bool, caps: bool, scroll: bool) {
        let mut leds = Led::empty();
        leds.set(Led::NUMLOCK, num);
        leds.set(Led::CAPSLOCK, caps);
        leds.set(Led::SCROLLLOCK, scroll);
        self.inputs.leds = leds;
        for device in self.inputs.devices.iter_mut().filter(|d| d.keyboard) {
            device.handle.led_update(leds);
        }
    }

    /// At startup: the saved keymap (or the default when it does not compile), the repeat rate and NumLock.
    pub fn input_start(&mut self) {
        let keyboard = self.seat.get_keyboard();
        if let Some(keyboard) = keyboard {
            let xkb = self.inputs.config.xkb();
            if xkb != Xkb::default()
                && let Err(e) = keyboard.set_xkb_config(self, xkb.config())
            {
                log::warn!("键盘布局 {:?}: {e:?}, 用默认的", self.inputs.config.keyboard.layouts);
            }
            let (rate, delay) = self.inputs.config.repeat();
            keyboard.change_repeat_info(rate, delay);
            let numlock = self.inputs.config.keyboard.numlock;
            if numlock != NumLock::Unchanged {
                let mut mods = keyboard.modifier_state();
                mods.num_lock = numlock == NumLock::On;
                keyboard.set_modifier_state(mods);
                let leds = keyboard.led_state();
                self.input_leds(leds.num.unwrap_or(false), leds.caps.unwrap_or(false), leds.scroll.unwrap_or(false));
            }
        }
        self.input_layouts();
    }

    fn input_layouts(&mut self) {
        let Some(keyboard) = self.seat.get_keyboard() else { return };
        self.inputs.layouts = keyboard.with_xkb_state(self, |ctx| {
            let Ok(xkb) = ctx.xkb().lock() else { return Vec::new() };
            xkb.layouts().map(|l| xkb.layout_name(l).to_owned()).collect()
        });
        self.inputs.current = keyboard.modifier_state().serialized.layout_effective;
    }

    /// After a key: whether the layout changed (xkb's group switching options), to tell the runtime.
    pub fn input_layout_changed(&mut self) {
        let Some(keyboard) = self.seat.get_keyboard() else { return };
        let current = keyboard.modifier_state().serialized.layout_effective;
        if current != self.inputs.current {
            self.inputs.current = current;
            self.emit_input();
        }
    }

    pub fn emit_input(&mut self) {
        let state = self.inputs.state();
        self.emit(ShellEvent::Input(state.to_string()));
    }

    pub fn input_event(&self) -> ShellEvent {
        ShellEvent::Input(self.inputs.state().to_string())
    }

    /// `acde_shell.set_input`: a partial configuration (JSON); applied, saved, then told to the runtime.
    pub fn set_input(&mut self, patch: &str) -> Result<(), String> {
        let patch: Value = serde_json::from_str(patch).map_err(|e| format!("输入设置不是 JSON: {e}"))?;
        let next = self.inputs.config.patched(&patch)?;
        let keyboard = self.seat.get_keyboard().ok_or("没有键盘")?;
        let xkb = next.xkb();
        if xkb != self.inputs.config.xkb() {
            keyboard.set_xkb_config(self, xkb.config()).map_err(|_| format!("编译不出键盘布局 {}({}) {}", xkb.layout, xkb.variant, xkb.options.as_deref().unwrap_or("")))?;
        }
        let (rate, delay) = next.repeat();
        keyboard.change_repeat_info(rate, delay);
        self.inputs.config = next;
        let config = self.inputs.config.clone();
        for device in &mut self.inputs.devices {
            device.apply(&config);
        }
        self.input_layouts();
        let saved = config.save();
        self.emit_input();
        saved.map_err(|e| format!("保存输入设置: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_patch_changes_only_what_it_names() {
        let c = InputConfig::default();
        let c = c.patched(&json!({ "keyboard": { "layouts": [{ "layout": "us" }, { "layout": "de", "variant": "nodeadkeys" }], "options": ["grp:alt_shift_toggle"] }, "touchpad": { "tapToClick": false } })).unwrap();
        assert_eq!(c.keyboard.repeat_delay, 600);
        assert_eq!(c.touchpad.tap_to_click, Some(false));
        assert_eq!(c.mouse, Pointer::default());
        let x = c.xkb();
        assert_eq!((x.layout.as_str(), x.variant.as_str(), x.options.as_deref()), ("us,de", ",nodeadkeys", Some("grp:alt_shift_toggle")));
        let c = c.patched(&json!({ "touchpad": { "tapToClick": null }, "mouse": { "speed": 3 } })).unwrap();
        assert_eq!(c.touchpad.tap_to_click, None);
        assert_eq!(c.mouse.speed, Some(1.0));
    }

    #[test]
    fn bad_names_and_too_many_layouts_are_refused() {
        let c = InputConfig::default();
        assert!(c.patched(&json!({ "keyboard": { "layouts": [{ "layout": "us;rm" }] } })).is_err());
        let five: Vec<Value> = (0..5).map(|_| json!({ "layout": "us" })).collect();
        assert!(c.patched(&json!({ "keyboard": { "layouts": five } })).is_err());
        assert!(c.patched(&json!({ "keyboard": { "numlock": "maybe" } })).is_err());
    }

    #[test]
    fn repeat_off_is_rate_zero() {
        let c = InputConfig::default().patched(&json!({ "keyboard": { "repeat": false } })).unwrap();
        assert_eq!(c.repeat(), (0, 600));
        assert_eq!(InputConfig::default().repeat(), (25, 600));
        assert_eq!(InputConfig::default().xkb(), Xkb::default());
    }
}
