use std::path::{Path, PathBuf};

const HEADER: &str = "include/acdert.h";
const FFI: &str = "src/ffi.rs";
const PREFIX: &str = "acdert_";

enum Linker {
    Gnu,
    Apple,
    Msvc,
}

impl Linker {
    fn current() -> Self {
        match (std::env::var("CARGO_CFG_TARGET_OS").as_deref(), std::env::var("CARGO_CFG_TARGET_ENV").as_deref()) {
            (Ok("macos" | "ios"), _) => Self::Apple,
            (_, Ok("msvc")) => Self::Msvc,
            _ => Self::Gnu,
        }
    }

    fn exports(&self, names: &[String], out: &Path) {
        let (file, text, arg) = match self {
            Self::Gnu => ("acdert.map", format!("{{\n  global:\n    {PREFIX}*;\n  local:\n    *;\n}};\n"), "-Wl,--exclude-libs,ALL,--version-script="),
            Self::Apple => ("acdert.exports", format!("_{PREFIX}*\n"), "-Wl,-exported_symbols_list,"),
            Self::Msvc => ("acdert.def", format!("EXPORTS\n{}\n", names.iter().map(|n| format!("  {n}")).collect::<Vec<_>>().join("\n")), "/DEF:"),
        };
        let path = out.join(file);
        std::fs::write(&path, text).expect("export list");
        println!("cargo:rustc-cdylib-link-arg={arg}{}", path.display());
    }
}

fn main() {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    for watched in ["src/lib.rs", FFI, "cbindgen.toml"] {
        println!("cargo:rerun-if-changed={watched}");
    }
    cbindgen::generate(&dir).expect("cbindgen: src/ffi.rs").write_to_file(dir.join(HEADER));
    let source = std::fs::read_to_string(dir.join(FFI)).expect("src/ffi.rs");
    let names: Vec<String> = source
        .lines()
        .filter_map(|line| line.split_once("extern \"C\" fn ").map(|(_, rest)| rest))
        .filter(|rest| rest.starts_with(PREFIX))
        .map(|rest| rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect())
        .collect();
    Linker::current().exports(&names, &out);
}
