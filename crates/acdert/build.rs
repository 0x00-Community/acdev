use std::path::Path;

fn main() {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    let sources = Path::new(env!("CARGO_MANIFEST_DIR")).join("../acde-napi/src");
    println!("cargo:rerun-if-changed={}", sources.display());
    let texts: Vec<String> = std::fs::read_dir(&sources)
        .expect("acde-napi sources")
        .map(|entry| entry.expect("acde-napi source").path())
        .filter(|path| path.extension().is_some_and(|e| e == "rs"))
        .map(|path| std::fs::read_to_string(&path).expect("acde-napi source"))
        .collect();
    let ident = |text: &str| -> String { text.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect() };
    let mut makers = Vec::new();
    for text in &texts {
        let mut maker: Option<String> = None;
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("macro_rules! ") {
                maker = Some(ident(rest));
            } else if line.trim() == "#[napi_sym]" {
                if let Some(name) = maker.take() {
                    makers.push(name);
                }
            } else if line == "}" {
                maker = None;
            }
        }
    }
    let mut names = Vec::new();
    for text in &texts {
        let mut exported = false;
        let mut block = false;
        for line in text.lines() {
            if block {
                if line == "}" {
                    block = false;
                } else if let Some(entry) = line.strip_prefix("    ").filter(|e| !e.starts_with(' ')) {
                    let name = ident(entry);
                    if name.starts_with("napi_") || name.starts_with("node_api_") {
                        names.push(name);
                    }
                }
                continue;
            }
            if let Some(called) = line.strip_suffix("! {")
                && makers.iter().any(|m| m == called)
            {
                block = true;
                continue;
            }
            let line = line.trim();
            if line == "#[napi_sym]" || line == "#[unsafe(no_mangle)]" {
                exported = true;
                continue;
            }
            if !exported || line.starts_with("#[") {
                continue;
            }
            exported = false;
            let Some((_, rest)) = line.split_once("fn ") else { continue };
            let name = ident(rest);
            if !name.is_empty() && !name.starts_with('$') {
                names.push(name);
            }
        }
    }
    names.sort();
    names.dedup();
    let def = Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("napi.def");
    std::fs::write(&def, format!("EXPORTS\n{}\n", names.iter().map(|n| format!("  {n}")).collect::<Vec<_>>().join("\n"))).expect("napi.def");
    println!("cargo:rustc-link-arg-bin=acdert=/DEF:{}", def.display());
}
