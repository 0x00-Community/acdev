use std::path::Path;

fn main() {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    let sources = Path::new(env!("CARGO_MANIFEST_DIR")).join("../acde-napi/src");
    println!("cargo:rerun-if-changed={}", sources.display());
    let mut names = Vec::new();
    for entry in std::fs::read_dir(&sources).expect("acde-napi sources") {
        let path = entry.expect("acde-napi source").path();
        if path.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("acde-napi source");
        let mut exported = false;
        for line in text.lines().map(str::trim) {
            if line == "#[napi_sym]" || line == "#[unsafe(no_mangle)]" {
                exported = true;
                continue;
            }
            if !exported || line.starts_with("#[") {
                continue;
            }
            exported = false;
            let Some((_, rest)) = line.split_once("fn ") else { continue };
            let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            if !name.is_empty() {
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
