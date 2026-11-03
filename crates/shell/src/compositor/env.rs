use std::sync::LazyLock;

pub struct Env {
    pub debug_input: bool,
    pub scanout: bool,
}

pub static ENV: LazyLock<Env> = LazyLock::new(|| Env {
    debug_input: std::env::var_os("ACDE_DEBUG_INPUT").is_some(),
    scanout: std::env::var("ACDE_SCANOUT").map_or(true, |v| v != "0"),
});
