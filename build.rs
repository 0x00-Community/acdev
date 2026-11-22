fn main() {
    println!("cargo:rerun-if-env-changed=DEP_ACDE_NAPI_DEF");
    if let Ok(def) = std::env::var("DEP_ACDE_NAPI_DEF") {
        println!("cargo:rustc-link-arg-bins=/DEF:{def}");
    }
}
