use std::time::Duration;

use acde::model::{BTN_LEFT, Injected, WheelSource};
use acde::v8;
use acde_hostwin::Shell;
use acde_scene::input::{Event, pace};

const BTN_RIGHT: u32 = 0x111;
const BTN_MIDDLE: u32 = 0x112;
const WAIT_MAX_MS: f64 = 10_000.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Step {
    Move(f64, f64),
    Button { at: (f64, f64), button: u32, pressed: bool },
    Wheel { at: (f64, f64), dx: f64, dy: f64 },
    Key { code: u32, pressed: bool },
}

pub fn sequence(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Result<Vec<Event<Step>>, String> {
    let list = v8::Local::<v8::Array>::try_from(value).map_err(|_| "injectSequence: the events are a list".to_owned())?;
    (0..list.length())
        .map(|i| {
            let item = list.get_index(scope, i).ok_or("injectSequence: an event is missing")?;
            event(scope, item).map_err(|why| format!("injectSequence: event {i}: {why}"))
        })
        .collect()
}

fn event(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Result<Event<Step>, String> {
    let object = v8::Local::<v8::Object>::try_from(value).map_err(|_| "not an object".to_owned())?;
    let text = |scope: &mut v8::PinScope, name: &str| {
        acde::get(scope, object, name).filter(|v| v.is_string()).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default()
    };
    let number = |scope: &mut v8::PinScope, name: &str| {
        let found = acde::get(scope, object, name).filter(|v| v.is_number()).and_then(|v| v.number_value(scope));
        found.filter(|n| n.is_finite()).ok_or_else(|| format!("{name} is a number"))
    };
    let kind = text(scope, "type");
    let point = |scope: &mut v8::PinScope| Ok::<_, String>((number(scope, "x")?, number(scope, "y")?));
    Ok(match kind.as_str() {
        "move" => {
            let (x, y) = point(scope)?;
            Event::Move(Step::Move(x, y))
        }
        "down" | "up" => {
            let pressed = kind == "down";
            let step = Step::Button { at: point(scope)?, button: button(&text(scope, "button"))?, pressed };
            if pressed { Event::Down(step) } else { Event::Up(step) }
        }
        "wheel" => Event::Other(Step::Wheel { at: point(scope)?, dx: number(scope, "dx").unwrap_or(0.0), dy: number(scope, "dy").unwrap_or(0.0) }),
        "keydown" | "keyup" => Event::Other(Step::Key { code: number(scope, "code")? as u32, pressed: kind == "keydown" }),
        "wait" => {
            let ms = number(scope, "ms").ok().filter(|ms| (0.0..=WAIT_MAX_MS).contains(ms)).ok_or("wait takes ms from 0 to 10000")?;
            Event::Wait(Duration::from_millis(ms as u64))
        }
        other => return Err(format!("no input event {other:?} (move, down, up, wheel, keydown, keyup or wait)")),
    })
}

fn button(name: &str) -> Result<u32, String> {
    match name {
        "" | "left" => Ok(BTN_LEFT),
        "right" => Ok(BTN_RIGHT),
        "middle" => Ok(BTN_MIDDLE),
        other => Err(format!("button is left, right or middle, not {other}")),
    }
}

pub fn play(events: Vec<Event<Step>>) -> Result<(), String> {
    let shell = Shell::open().ok_or("Shell: not open")?;
    let mut pointer = None;
    for event in pace(events) {
        match event {
            Event::Wait(gap) => std::thread::sleep(gap),
            Event::Move(step) | Event::Down(step) | Event::Up(step) | Event::Other(step) => {
                for injected in injections(step, &mut pointer) {
                    shell.inject(injected);
                }
            }
        }
    }
    Ok(())
}

fn injections(step: Step, pointer: &mut Option<(f64, f64)>) -> Vec<Injected> {
    let mut to = |at: (f64, f64)| {
        let moved = *pointer != Some(at);
        *pointer = Some(at);
        moved.then_some(Injected::Move(at.0, at.1))
    };
    match step {
        Step::Move(x, y) => {
            *pointer = Some((x, y));
            vec![Injected::Move(x, y)]
        }
        Step::Button { at, button, pressed } => to(at).into_iter().chain([Injected::Button { button, pressed }]).collect(),
        Step::Wheel { at, dx, dy } => to(at).into_iter().chain([Injected::Wheel { dx, dy, source: WheelSource::Wheel }]).collect(),
        Step::Key { code, pressed } => vec![Injected::Key { code, pressed }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_press_moves_the_pointer_there_first_only_when_it_is_elsewhere() {
        let mut pointer = None;
        let press = Step::Button { at: (5.0, 5.0), button: BTN_LEFT, pressed: true };
        assert_eq!(injections(press, &mut pointer), [Injected::Move(5.0, 5.0), Injected::Button { button: BTN_LEFT, pressed: true }]);
        let release = Step::Button { at: (5.0, 5.0), button: BTN_LEFT, pressed: false };
        assert_eq!(injections(release, &mut pointer), [Injected::Button { button: BTN_LEFT, pressed: false }]);
        assert_eq!(injections(Step::Move(9.0, 1.0), &mut pointer), [Injected::Move(9.0, 1.0)]);
        assert_eq!(pointer, Some((9.0, 1.0)));
    }

    #[test]
    fn button_names_are_the_evdev_buttons() {
        assert_eq!(button("left"), Ok(BTN_LEFT));
        assert_eq!(button(""), Ok(BTN_LEFT));
        assert_eq!(button("middle"), Ok(BTN_MIDDLE));
        assert!(button("thumb").is_err());
    }
}
