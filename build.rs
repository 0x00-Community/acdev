use std::path::PathBuf;

const HEADER: &str = "include/acdert.h";

fn main() {
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    for watched in ["src/lib.rs", "src/ffi.rs", "cbindgen.toml"] {
        println!("cargo:rerun-if-changed={watched}");
    }
    cbindgen::generate(&dir).expect("cbindgen: src/ffi.rs").write_to_file(dir.join(HEADER));
}
