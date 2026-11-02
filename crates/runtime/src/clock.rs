use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct Clock;

impl Clock {
    pub fn now() -> Duration {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default()
    }
}
