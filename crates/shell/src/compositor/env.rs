use std::sync::LazyLock;

pub struct Env {
    pub debug_input: bool,
}

pub static ENV: LazyLock<Env> = LazyLock::new(|| Env { debug_input: std::env::var_os("ACDE_DEBUG_INPUT").is_some() });
