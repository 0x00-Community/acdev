use napi::Status;
use rustix::io::Errno;
use serde::Serialize;
use std::io;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Code {
    HttpError,
    InvalidRequest,
    InternalError,
    #[serde(untagged)]
    Service(String),
}

#[derive(Debug, Serialize)]
pub(crate) struct Failure {
    pub status: u16,
    pub code: Code,
    pub message: String,
    retryable: bool,
}

pub(crate) type Outcome<T> = std::result::Result<T, Failure>;

impl Failure {
    pub fn http(status: u16, message: impl Into<String>) -> Self {
        Self::new(status, Code::HttpError, message)
    }
    pub fn new(status: u16, code: Code, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into(), retryable: false }
    }
    pub fn token_refused(message: &str) -> Self {
        Self::new(403, Code::Service("token_refused".into()), message)
    }
    pub fn office_config(message: impl Into<String>) -> Self {
        Self::new(503, Code::Service("office_config".into()), message)
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(400, Code::InvalidRequest, message)
    }
    pub fn internal(detail: impl std::fmt::Display) -> Self {
        log::error!("operation failed: {detail}");
        Self::new(500, Code::InternalError, "Runtime server operation failed")
    }
    pub fn shown_in_state(&self) -> bool {
        matches!(self.code, Code::InvalidRequest) || self.status == 404
    }
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        let mapped = match Errno::from_io_error(&error) {
            Some(Errno::NOENT) => (404, "no such file or directory"),
            Some(Errno::ACCESS) => (403, "permission denied"),
            Some(Errno::PERM) => (403, "operation not permitted"),
            Some(Errno::EXIST) => (409, "already exists"),
            Some(Errno::NOTEMPTY) => (409, "directory is not empty"),
            Some(Errno::NOTDIR) => (400, "not a directory"),
            Some(Errno::ISDIR) => (400, "is a directory"),
            Some(Errno::LOOP) => (400, "refusing to follow a symlink"),
            Some(Errno::NAMETOOLONG) => (400, "name too long"),
            Some(Errno::XDEV) => (400, "cannot move across filesystems"),
            Some(Errno::NOSPC) => (507, "no space left on device"),
            Some(Errno::ROFS) => (403, "read-only filesystem"),
            _ => return Self::internal(error),
        };
        Self::http(mapped.0, mapped.1)
    }
}

impl From<Failure> for napi::Error {
    fn from(failure: Failure) -> Self {
        napi::Error::new(
            Status::GenericFailure,
            serde_json::to_string(&failure).unwrap_or(failure.message),
        )
    }
}
