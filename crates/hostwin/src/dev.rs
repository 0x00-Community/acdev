use acde_model::Event;
use winit::event_loop::EventLoopProxy;

use crate::app::{Cmd, server};

pub(crate) fn connect(proxy: EventLoopProxy<Cmd>) {
    let Ok(endpoint) = std::env::var("ACDE_DEV") else { return };
    let spawned = std::thread::Builder::new().name("acde-dev".into()).spawn(move || {
        let stream = match acde_ipc::connect(&endpoint) {
            Ok(s) => s,
            Err(e) => {
                log::error!("acde dev: 连不上 {endpoint}: {e}");
                return;
            }
        };
        if let Ok(mut writer) = stream.try_clone() {
            let _ = acde_ipc::send(&mut writer, &format!(r#"{{"type":"hello","pid":{}}}"#, std::process::id()));
        }
        let mut lines = acde_ipc::Lines::new(stream);
        while let Ok(Some(line)) = lines.next_line() {
            handle(&line, &proxy);
        }
        log::info!("acde dev 断开了, 结束");
        let _ = proxy.send_event(Cmd::Exit(0));
    });
    if let Err(e) = spawned {
        log::error!("acde dev 线程: {e}");
    }
}

fn handle(line: &str, proxy: &EventLoopProxy<Cmd>) {
    let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
        log::warn!("acde dev: 看不懂 {line}");
        return;
    };
    match message.get("type").and_then(|t| t.as_str()) {
        Some("reload") => {
            let app = message.get("app").and_then(|a| a.as_str()).map(str::to_owned);
            log::info!("acde dev: 重新加载 {}", app.as_deref().unwrap_or("桌面"));
            if let Some(server) = server() {
                server.broker.push(Event { kind: "devreload".into(), key: app, ..Default::default() });
            }
        }
        Some("quit") => {
            let _ = proxy.send_event(Cmd::Exit(0));
        }
        other => log::warn!("acde dev: 没有 {other:?} 这种消息"),
    }
}
