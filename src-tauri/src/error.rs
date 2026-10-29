use serde::Serialize;

#[derive(Serialize, Debug)]
pub struct CmdError {
    pub code: &'static str,
    pub message: String,
}

pub type CmdResult<T> = Result<T, CmdError>;

impl From<focus_core::Error> for CmdError {
    fn from(e: focus_core::Error) -> Self {
        use focus_core::Error::*;
        let code = match &e {
            Db(_) | Io(_) => "storage",
            Invalid(_) => "invalid",
            Forbidden(_) => "forbidden",
            NotFound(_) => "not_found",
            Pairing(_) => "pairing",
            Integrity(_) => "integrity",
            UnsupportedSchema(_) => "unsupported_schema",
            StaleRevision { .. } => "stale",
            RateLimited(_) => "rate_limited",
            Locked => "locked",
            Network(_) => "network",
        };
        // Messages never contain secrets (see focus-core::Error).
        CmdError {
            code,
            message: e.to_string(),
        }
    }
}

impl CmdError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
