use std::str::FromStr;
use std::sync::Arc;

use acde_model::{Mode, Scope};
use acde_shell::compositor::Animate;
use serde::Deserialize;
use serde_json::{Value, json};

use super::js::{AnimateOptions, LaunchOptions};
use super::{Desk, Done, Failure};
use crate::wire::{Answer, Args, Fail, Ret, WireArgs};

impl From<Failure> for Fail {
    fn from(f: Failure) -> Self {
        Fail { message: f.message, status: f.status, code: f.code.to_owned() }
    }
}

fn now(done: Done<Value>) -> Answer {
    Answer::Now(done.map(Ret::Json).map_err(Fail::from))
}

fn later(work: impl FnOnce() -> Done<Value> + Send + 'static) -> Answer {
    Answer::Later(Box::new(move || work().map(Ret::Json).map_err(Fail::from)))
}

fn arg<T: for<'de> Deserialize<'de>>(a: &mut WireArgs, i: usize) -> Option<T> {
    serde_json::from_value(a.json(i)).ok()
}

fn window(a: &mut WireArgs, i: usize) -> u32 {
    let n = a.f64(i);
    if n.is_finite() && n >= 0.0 { n as u32 } else { 0 }
}

fn rect(a: &mut WireArgs, i: usize) -> [i32; 4] {
    let v: Vec<f64> = arg(a, i).unwrap_or_default();
    std::array::from_fn(|n| v.get(n).copied().unwrap_or(0.0).round() as i32)
}

fn desktop_call(desk: &Arc<Desk>, me: u32, what: &str, f: impl FnOnce(&Desk) -> Done<Value>) -> Answer {
    now(desk.desktop_only(me, what).and_then(|()| f(desk)))
}

fn null(done: Done<()>) -> Done<Value> {
    done.map(|()| Value::Null)
}

pub fn call(name: &str, a: &mut WireArgs, desk: &Arc<Desk>, me: u32) -> Answer {
    let desk = desk.clone();
    match name {
        "launch" => {
            let argv: Vec<String> = arg(a, 0).unwrap_or_default();
            let options: LaunchOptions = arg(a, 1).unwrap_or_default();
            let env: Vec<(String, String)> = options.env.into_iter().collect();
            now(desk.start_program(me, &argv, options.cwd.as_deref(), &env, options.slot).map(Value::from))
        }
        "close" => {
            let window = window(a, 0);
            later(move || desk.close(me, window).map(Value::from))
        }
        "kill" => {
            let window = window(a, 0);
            later(move || desk.kill(me, window).map(Value::from))
        }
        "focus" => {
            let window = window(a, 0);
            desktop_call(&desk, me, &format!("window {window}"), |desk| {
                desk.link().focus(window);
                Ok(Value::Null)
            })
        }
        "hide" | "show" => {
            let (window, hide) = (window(a, 0), name == "hide");
            desktop_call(&desk, me, &format!("window {window}"), |desk| {
                desk.hide(window, hide);
                Ok(Value::Null)
            })
        }
        "invokeMenu" => {
            let window = window(a, 0);
            let (menu, item) = (a.json(1), a.json(2));
            later(move || {
                let answer = desk.invoke_menu(me, window, menu, item)?;
                Ok(answer.recv_timeout(std::time::Duration::from_secs(10)).unwrap_or(Value::Null))
            })
        }
        "stats" => desktop_call(&desk, me, "compositor stats", |desk| {
            let s = desk.link().stats(false);
            Ok(json!({ "frames": s.frames, "composeP50": s.compose_p50, "composeP95": s.compose_p95, "composeMax": s.compose_max, "plans": s.plans, "direct": s.direct }))
        }),
        "screenshot" => {
            let path: Option<String> = arg(a, 0);
            later(move || {
                desk.desktop_only(me, "screenshots")?;
                desk.screenshot(path)
            })
        }
        "animate" => {
            let window = window(a, 0);
            let options: AnimateOptions = arg(a, 1).unwrap_or_default();
            desktop_call(&desk, me, &format!("animating window {window}"), |desk| {
                desk.link().animate(window, Animate::try_from(options)?);
                Ok(Value::Null)
            })
        }
        "shortcut" | "unshortcut" => {
            let combo = a.str(0);
            let scope: Option<String> = arg(a, 1);
            let on = name == "shortcut";
            now(scope.as_deref().map(Scope::from_str).transpose().map_err(Failure::from).and_then(|s| desk.shortcut(me, combo, s, on)).map(|()| Value::Null))
        }
        "panelOpen" => match desk.panel_open(me, rect(a, 0)) {
            Ok((window, token)) => Answer::ok(Ret::Obj(vec![("window", Ret::Num(f64::from(window))), ("token", Ret::Str(token.to_string()))])),
            Err(failure) => Answer::Now(Err(failure.into())),
        },
        "panelPlace" => {
            let (window, rect) = (window(a, 0), rect(a, 1));
            now(null(desk.panel_place(me, window, rect)))
        }
        "panelClose" => {
            let window = window(a, 0);
            now(null(desk.panel_close(me, window)))
        }
        "setTitle" => {
            let title = a.str(0);
            now(null(desk.set_title(me, title)))
        }
        "setMenus" => {
            let menus = a.json(0);
            now(null(desk.set_menus(me, menus)))
        }
        "closeSelf" => later(move || Ok(desk.close_window(me, true).into())),
        "minimize" => now(null(desk.tell(me, "windowminimize"))),
        "requestAttention" => now(null(desk.tell(me, "windowattention"))),
        "ready" => now(null(desk.tell(me, "windowready"))),
        "reload" => {
            let url: Option<String> = arg(a, 0);
            now(desk.reload(me, url).map(Value::from))
        }
        "openUrl" => {
            let url = a.str(0);
            now(desk.open_url(me, &url).map(Value::from))
        }
        "shown" => {
            desk.shown(me);
            Answer::ok(())
        }
        "download" => {
            let (name, kind) = (a.str(0), a.str(1));
            let Some(bytes) = a.with_bytes(2, <[u8]>::to_vec) else { return Answer::fail("download: the data is bytes") };
            later(move || desk.download(me, &name, &kind, &bytes).map(Value::from))
        }
        "notify" => {
            let notification = a.json(0);
            desk.notify(me, &notification);
            Answer::ok(())
        }
        "apps" => now(Ok(desk.app_list())),
        "openApp" => {
            let app = a.str(0);
            let request = Some(a.json(1)).filter(|r| !r.is_null());
            let (desktop, who, caps) = desk.rights(me);
            now(if desktop || caps.opens(&app) { desk.launch(&app, request, Mode::Free).map(|window| json!({ "window": window })) } else { Err(Failure::refused(&who, &format!("open {app}"))) })
        }
        "sessionOwn" => Answer::ok(desk.session_own()),
        "endSession" => {
            let kind = a.str(0);
            match super::End::try_from(kind.as_str()) {
                Ok(end) => later(move || desk.end_session(me, end).map(|()| Value::Null)),
                Err(failure) => Answer::Now(Err(failure.into())),
            }
        }
        "setLanguage" => {
            let tag = a.str(0);
            now(null(desk.set_language(me, &tag)))
        }
        "desktops" => now(desk.desktops(me)),
        "displays" => now(desk.displays(me)),
        "setScale" => {
            let (output, scale) = (a.str(0), a.f64(1));
            later(move || desk.set_scale(me, &output, scale).map(|()| Value::Null))
        }
        "inputState" => now(desk.input_state(me)),
        "setInput" => {
            let patch: Value = arg(a, 0).unwrap_or(Value::Null);
            later(move || desk.set_input(me, &patch).map(|()| Value::Null))
        }
        "inputCatalog" => later(move || desk.input_catalog(me)),
        "setBrightness" => {
            let (output, value) = (a.str(0), a.f64(1));
            later(move || desk.set_brightness(me, &output, value).map(|()| Value::Null))
        }
        "chooseDesktop" => {
            let (id, remember) = (a.str(0), a.bool(1));
            now(null(desk.choose_desktop(me, &id, remember)))
        }
        "openPath" => {
            let target = a.str(0);
            let options: super::OpenOptions = arg(a, 1).unwrap_or_default();
            later(move || desk.open_path(Some(me), &target, options))
        }
        "handlers" => {
            let target = a.str(0);
            later(move || desk.handlers(Some(me), &target))
        }
        "setDefault" => {
            let (mime, app) = (a.str(0), a.str(1));
            now(desk.set_default(Some(me), &mime, &app).map(Value::from))
        }
        "inspectSnapshot" => {
            let options: super::SnapshotOptions = arg(a, 0).unwrap_or_default();
            later(move || {
                desk.desktop_only(me, "acde.inspect")?;
                desk.inspect_snapshot(options)
            })
        }
        "inspectRun" => match arg::<Vec<super::Step>>(a, 0) {
            Some(steps) => later(move || {
                desk.desktop_only(me, "acde.inspect")?;
                desk.inspect_run(steps)
            }),
            None => Answer::fail("inspect: steps are [{ref, action, text?}]"),
        },
        "inspectOpen" => {
            let name = a.str(0);
            later(move || {
                desk.desktop_only(me, "acde.inspect")?;
                desk.inspect_open(&name)
            })
        }
        _ => Answer::fail(format!("desk: no method {name}")),
    }
}
