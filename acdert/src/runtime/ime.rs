use crate::runtime::js::JsText;
use crate::runtime::sync::Locked;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use zbus::blocking::{Connection, Proxy};
use zbus::proxy::MethodFlags;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Structure, StructureBuilder, Value as Variant};

type Result<T> = std::result::Result<T, String>;

const FCITX: &str = "org.fcitx.Fcitx5";
const PORTAL: &str = "org.freedesktop.portal.IBus";
const IBUS_RELEASE: u32 = 1 << 30;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Backend {
    Fcitx,
    Ibus,
}

#[derive(Default)]
pub struct ImeCapability {
    pub preedit: bool,
    pub surrounding_text: bool,
    pub password: bool,
    pub client_panel: bool,
}

#[derive(Default)]
struct Surrounding {
    text: String,
    cursor: usize,
}

impl Surrounding {
    fn chars(text: &str, units: usize) -> u32 {
        let mut seen = 0;
        text.chars()
            .take_while(|c| {
                seen += c.len_utf16();
                seen <= units
            })
            .count() as u32
    }
    fn units(&self, offset: i32, length: u32) -> (i64, u64) {
        let chars: Vec<char> = self.text.chars().collect();
        let at = Self::chars(&self.text, self.cursor) as i64;
        let start = (at + i64::from(offset)).clamp(0, chars.len() as i64) as usize;
        let end = (start + length as usize).min(chars.len());
        let unit = |range: &[char]| range.iter().map(|c| c.len_utf16() as i64).sum::<i64>();
        let start16 = unit(&chars[..start]);
        (start16 - self.cursor as i64, unit(&chars[start..end]) as u64)
    }
}

fn ibus_variant(text: &str) -> Result<Variant<'static>> {
    let attachments = std::collections::HashMap::<String, Variant<'static>>::new();
    let attributes: Structure<'static> = StructureBuilder::new()
        .add_field("IBusAttrList")
        .add_field(attachments.clone())
        .add_field(Vec::<Variant<'static>>::new())
        .build()
        .map_err(|e| e.to_string())?;
    let text: Structure<'static> = StructureBuilder::new()
        .add_field("IBusText")
        .add_field(attachments)
        .add_field(text.to_owned())
        .append_field(Variant::Value(Box::new(Variant::Structure(attributes))))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(Variant::Structure(text))
}

fn ibus_text(value: &Variant<'_>) -> Option<String> {
    let mut value = value;
    while let Variant::Value(inner) = value {
        value = inner;
    }
    let Variant::Structure(structure) = value else { return None };
    match structure.fields().get(2)? {
        Variant::Str(text) => Some(text.to_string()),
        _ => None,
    }
}

trait Quiet {
    fn quiet<B, R>(&self, method: &str, body: &B) -> zbus::Result<R>
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
        R: for<'d> zbus::zvariant::DynamicDeserialize<'d>;
    fn send<B>(&self, method: &str, body: &B) -> zbus::Result<()>
    where
        B: serde::Serialize + zbus::zvariant::DynamicType;
}
impl Quiet for Proxy<'_> {
    fn quiet<B, R>(&self, method: &str, body: &B) -> zbus::Result<R>
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
        R: for<'d> zbus::zvariant::DynamicDeserialize<'d>,
    {
        self.call_with_flags(method, MethodFlags::NoAutoStart.into(), body)?.ok_or_else(|| zbus::Error::Failure(format!("{method}: no reply")))
    }
    fn send<B>(&self, method: &str, body: &B) -> zbus::Result<()>
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
    {
        self.call_with_flags::<_, _, ()>(method, MethodFlags::NoAutoStart | MethodFlags::NoReplyExpected, body).map(drop)
    }
}

trait Bus<T> {
    fn bus(self) -> Result<T>;
}
impl<T> Bus<T> for zbus::Result<T> {
    fn bus(self) -> Result<T> {
        self.map_err(|error| error.to_string())
    }
}

pub struct Ime {
    backend: Backend,
    context: Proxy<'static>,
    surrounding: Arc<Mutex<Surrounding>>,
}

impl Ime {
    fn owned(connection: &Connection, name: &str) -> bool {
        let names = zbus::blocking::fdo::DBusProxy::new(connection);
        names.is_ok_and(|names| name.try_into().is_ok_and(|name| names.name_has_owner(name).unwrap_or(false)))
    }

    fn fcitx(connection: &Connection) -> zbus::Result<Proxy<'static>> {
        let im = Proxy::new(connection, FCITX, "/org/freedesktop/portal/inputmethod", "org.fcitx.Fcitx.InputMethod1")?;
        let args = vec![("program".to_owned(), "acde".to_owned()), ("display".to_owned(), "wayland:".to_owned())];
        let (path, _uuid): (OwnedObjectPath, Vec<u8>) = im.quiet("CreateInputContext", &(args,))?;
        Proxy::new(connection, FCITX, path, "org.fcitx.Fcitx.InputContext1")
    }

    fn ibus(connection: &Connection) -> zbus::Result<Proxy<'static>> {
        let portal = Proxy::new(connection, PORTAL, "/org/freedesktop/IBus", "org.freedesktop.IBus.Portal")?;
        let path: OwnedObjectPath = portal.quiet("CreateInputContext", &("acde",))?;
        Proxy::new(connection, PORTAL, path, "org.freedesktop.IBus.InputContext")
    }

    pub fn open(sink: impl Fn(Value) + Send + 'static) -> Result<Self> {
        let connection = Connection::session().bus()?;
        let (backend, context) = match (Self::owned(&connection, FCITX), Self::owned(&connection, PORTAL)) {
            (true, _) => (Backend::Fcitx, Self::fcitx(&connection)),
            (false, true) => (Backend::Ibus, Self::ibus(&connection)),
            (false, false) => (Backend::Fcitx, Err(zbus::Error::Failure(format!("neither {FCITX} nor {PORTAL} is running")))),
        };
        let context = context.bus()?;
        let surrounding = Arc::new(Mutex::new(Surrounding::default()));
        let signals = context.receive_all_signals().bus()?;
        let seen = Arc::clone(&surrounding);
        std::thread::Builder::new()
            .name("acde-ime".into())
            .spawn(move || {
                for message in signals {
                    if let Some(event) = Self::event(backend, &message, &seen) {
                        sink(event);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let ime = Self { backend, context, surrounding };
        ime.set_capability(ImeCapability { preedit: true, ..ImeCapability::default() })?;
        Ok(ime)
    }

    fn event(backend: Backend, message: &zbus::Message, surrounding: &Mutex<Surrounding>) -> Option<Value> {
        let header = message.header();
        let member = header.member()?.as_str().to_owned();
        let body = message.body();
        match (backend, member.as_str()) {
            (Backend::Fcitx, "CommitString") => Some(json!({"type": "commit", "text": body.deserialize::<String>().ok()?})),
            (Backend::Fcitx, "UpdateFormattedPreedit") => {
                let (parts, cursor): (Vec<(String, i32)>, i32) = body.deserialize().ok()?;
                let text: String = parts.into_iter().map(|(text, _)| text).collect();
                let cursor = if cursor < 0 { -1 } else { text.units_before(cursor as usize) as i64 };
                Some(json!({"type": "preedit", "text": text, "cursor": cursor}))
            }
            (Backend::Fcitx, "UpdateClientSideUI") => {
                type Texts = Vec<(String, i32)>;
                type Panel = (Texts, i32, Texts, Texts, Vec<(String, String)>, i32, i32, bool, bool);
                let (preedit, cursor, aux_up, aux_down, candidates, highlight, layout, prev, next): Panel = body.deserialize().ok()?;
                let joined = |texts: Texts| texts.into_iter().map(|(text, _)| text).collect::<String>();
                let preedit = joined(preedit);
                let cursor = if cursor < 0 { -1 } else { preedit.units_before(cursor as usize) as i64 };
                let layout = match layout {
                    1 => "vertical",
                    2 => "horizontal",
                    _ => "default",
                };
                let candidates: Vec<Value> = candidates.into_iter().map(|(label, text)| json!({"label": label, "text": text})).collect();
                Some(json!({"type": "panel", "preedit": preedit, "preeditCursor": cursor, "auxUp": joined(aux_up),
                    "auxDown": joined(aux_down), "candidates": candidates, "highlight": highlight, "layout": layout,
                    "hasPrev": prev, "hasNext": next}))
            }
            (_, "DeleteSurroundingText") => {
                let (offset, length): (i32, u32) = body.deserialize().ok()?;
                let (offset, length) = surrounding.locked().units(offset, length);
                Some(json!({"type": "deleteSurrounding", "offset": offset, "length": length}))
            }
            (Backend::Fcitx, "ForwardKey") => {
                let (keysym, state, release): (u32, u32, bool) = body.deserialize().ok()?;
                Some(json!({"type": "forwardKey", "keysym": keysym, "state": state, "isRelease": release}))
            }
            (Backend::Ibus, "CommitText") => {
                let text: OwnedValue = body.deserialize().ok()?;
                Some(json!({"type": "commit", "text": ibus_text(&text)?}))
            }
            (Backend::Ibus, "UpdatePreeditText") => {
                let (text, cursor, visible): (OwnedValue, u32, bool) = body.deserialize().ok()?;
                let text = if visible { ibus_text(&text)? } else { String::new() };
                let units: usize = text.chars().take(cursor as usize).map(char::len_utf16).sum();
                Some(json!({"type": "preedit", "text": text, "cursor": units}))
            }
            (Backend::Ibus, "HidePreeditText") => Some(json!({"type": "preedit", "text": "", "cursor": 0})),
            (Backend::Ibus, "ForwardKeyEvent") => {
                let (keysym, keycode, state): (u32, u32, u32) = body.deserialize().ok()?;
                Some(json!({"type": "forwardKey", "keysym": keysym, "keycode": keycode, "state": state & !IBUS_RELEASE,
                    "isRelease": state & IBUS_RELEASE != 0}))
            }
            _ => None,
        }
    }

    pub fn backend(&self) -> String {
        match self.backend {
            Backend::Fcitx => "fcitx5".into(),
            Backend::Ibus => "ibus".into(),
        }
    }

    pub fn focus_in(&self) -> Result<()> {
        self.context.send("FocusIn", &()).bus()
    }

    pub fn focus_out(&self) -> Result<()> {
        self.context.send("FocusOut", &()).bus()
    }

    pub fn reset(&self) -> Result<()> {
        self.context.send("Reset", &()).bus()
    }

    pub fn set_cursor_rect(&self, x: i32, y: i32, width: i32, height: i32) -> Result<()> {
        let method = match self.backend {
            Backend::Fcitx => "SetCursorRect",
            Backend::Ibus => "SetCursorLocation",
        };
        self.context.send(method, &(x, y, width, height)).bus()
    }

    pub fn set_surrounding_text(&self, text: String, cursor: u32, anchor: u32) -> Result<()> {
        let (c, a) = (Surrounding::chars(&text, cursor as usize), Surrounding::chars(&text, anchor as usize));
        let sent: zbus::Result<()> = match self.backend {
            Backend::Fcitx => self.context.send("SetSurroundingText", &(text.as_str(), c, a)),
            Backend::Ibus => self.context.send("SetSurroundingText", &(ibus_variant(&text)?, c, a)),
        };
        sent.bus()?;
        *self.surrounding.locked() = Surrounding { text, cursor: cursor as usize };
        Ok(())
    }

    pub fn set_capability(&self, capability: ImeCapability) -> Result<()> {
        match self.backend {
            Backend::Fcitx => {
                let mut flags = 0u64;
                if capability.preedit {
                    flags |= (1 << 1) | (1 << 4);
                }
                if capability.password {
                    flags |= 1 << 3;
                }
                if capability.surrounding_text {
                    flags |= 1 << 6;
                }
                if capability.client_panel {
                    flags |= 1 << 39;
                }
                self.context.send("SetCapability", &(flags,)).bus()
            }
            Backend::Ibus => {
                let mut flags = 1u32 << 3;
                if capability.preedit {
                    flags |= 1;
                }
                if capability.surrounding_text {
                    flags |= 1 << 5;
                }
                self.context.send("SetCapabilities", &(flags,)).bus()
            }
        }
    }

    pub fn process_key(&self, keysym: u32, keycode: u32, state: u32, is_release: bool) -> Result<bool> {
        match self.backend {
            Backend::Fcitx => self.context.quiet("ProcessKeyEvent", &(keysym, keycode + 8, state, is_release, 0u32)),
            Backend::Ibus => {
                let state = if is_release { state | IBUS_RELEASE } else { state };
                self.context.quiet("ProcessKeyEvent", &(keysym, keycode, state))
            }
        }
        .bus()
    }

    fn fcitx_only<B>(&self, method: &str, body: &B) -> Result<()>
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
    {
        match self.backend {
            Backend::Fcitx => self.context.quiet(method, body).bus(),
            Backend::Ibus => Ok(()),
        }
    }

    pub fn select_candidate(&self, index: i32) -> Result<()> {
        self.fcitx_only("SelectCandidate", &(index,))
    }

    pub fn prev_page(&self) -> Result<()> {
        self.fcitx_only("PrevPage", &())
    }

    pub fn next_page(&self) -> Result<()> {
        self.fcitx_only("NextPage", &())
    }

    pub fn close(&self) -> Result<()> {
        self.fcitx_only("DestroyIC", &())
    }
}

impl Drop for Ime {
    fn drop(&mut self) {
        _ = self.context.connection().clone().close();
    }
}

#[cfg(test)]
mod tests {
    use super::{Ime, ImeCapability};
    use serde_json::Value;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    const CONTROL: u32 = 4;

    fn key(name: &str) -> (u32, u32) {
        match name {
            "n" => (0x6e, 49),
            "i" => (0x69, 23),
            "h" => (0x68, 35),
            "a" => (0x61, 30),
            "o" => (0x6f, 24),
            "x" => (0x78, 45),
            "space" => (0x20, 57),
            "BackSpace" => (0xff08, 14),
            "Escape" => (0xff1b, 1),
            _ => panic!("no key {name}"),
        }
    }

    struct Session {
        ime: Ime,
        events: Arc<Mutex<Vec<Value>>>,
    }

    impl Session {
        fn open() -> Self {
            let events = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&events);
            let ime = Ime::open(move |event| sink.lock().unwrap().push(event)).expect("an input method on the session bus");
            Self { ime, events }
        }

        fn press(&self, name: &str, state: u32) -> bool {
            let (sym, code) = key(name);
            let taken = self.ime.process_key(sym, code, state, false).unwrap();
            self.ime.process_key(sym, code, state, true).unwrap();
            taken
        }

        fn until(&self, what: &str, cond: impl Fn(&[Value]) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(3);
            while !cond(&self.events.lock().unwrap()) {
                assert!(Instant::now() < deadline, "{what}: not within 3 s; events: {:?}", self.events.lock().unwrap());
                std::thread::sleep(Duration::from_millis(10));
            }
        }

        fn last_preedit(&self) -> Option<Value> {
            self.events.lock().unwrap().iter().rev().find(|e| e["type"] == "preedit").cloned()
        }

        fn micros(&self, keys: &[&str], rounds: usize) -> (f64, f64) {
            let mut samples = Vec::new();
            for _ in 0..rounds {
                for name in keys {
                    let (sym, code) = key(name);
                    for release in [false, true] {
                        let start = Instant::now();
                        self.ime.process_key(sym, code, 0, release).unwrap();
                        samples.push(start.elapsed().as_secs_f64() * 1e6);
                    }
                }
            }
            samples.sort_by(f64::total_cmp);
            (samples[samples.len() / 2], samples[samples.len() * 99 / 100])
        }
    }

    #[test]
    #[ignore = "needs its own D-Bus session with fcitx5 and pinyin: tests/ime-check.sh"]
    fn fcitx5_pinyin() {
        let s = Session::open();
        assert_eq!(s.ime.backend(), "fcitx5");
        s.ime.set_capability(ImeCapability { preedit: true, surrounding_text: true, ..ImeCapability::default() }).unwrap();
        s.ime.focus_in().unwrap();
        s.ime.set_cursor_rect(100, 200, 2, 18).unwrap();

        assert!(!s.press("x", 0), "x before activation is the page's");
        assert!(s.press("space", CONTROL), "Ctrl+Space toggles the input method");
        for letter in ["n", "i", "h", "a", "o"] {
            assert!(s.press(letter, 0), "{letter} taken");
        }
        s.until("preedit \"ni hao\"", |events| {
            events.iter().any(|e| e["type"] == "preedit" && e["text"].as_str().is_some_and(|t| t.replace([' ', '\''], "") == "nihao"))
        });
        let preedit = s.last_preedit().unwrap();
        let units = preedit["text"].as_str().unwrap().encode_utf16().count() as i64;
        let cursor = preedit["cursor"].as_i64().unwrap();
        assert!((0..=units).contains(&cursor), "preedit cursor within the text (UTF-16): {preedit}");
        assert!(s.press("space", 0), "space commits");
        s.until("commit", |events| events.iter().any(|e| e["type"] == "commit"));
        let committed = s.events.lock().unwrap().iter().find(|e| e["type"] == "commit").cloned().unwrap();
        assert_eq!(committed["text"], "你好");
        s.until("preedit cleared", |events| events.iter().rev().find(|e| e["type"] == "preedit").is_some_and(|e| e["text"] == ""));

        s.press("Escape", 0);
        let composing = s.micros(&["a", "BackSpace"], 500);
        s.press("Escape", 0);
        s.press("space", CONTROL);
        let through = s.micros(&["x"], 1000);
        println!(
            "processKey composing (pinyin): median {:.0} µs, p99 {:.0} µs; passed through to the page: median {:.0} µs, p99 {:.0} µs",
            composing.0, composing.1, through.0, through.1
        );
        assert!(through.0 < 1000.0, "processKey round trip under 1 ms (median): {through:?}");

        let start = Instant::now();
        for i in 0..1000 {
            s.ime.set_cursor_rect(100 + i % 7, 200, 2, 18).unwrap();
        }
        let each = start.elapsed().as_secs_f64() * 1e6 / 1000.0;
        println!("setCursorRect: {each:.1} µs per call");
        assert!(each < 100.0, "setters return without a round trip (< 100 µs): {each}");
        assert!(!s.press("x", 0), "a key after them still gets an answer");

        s.ime.set_surrounding_text("a😀中b".into(), 4, 4).unwrap();
        s.ime.focus_out().unwrap();
        s.ime.focus_in().unwrap();
        s.ime.reset().unwrap();
        s.ime.close().unwrap();
    }
}
