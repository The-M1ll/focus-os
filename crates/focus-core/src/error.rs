use thiserror::Error;

/// Errors surfaced by the classroom core. Messages never contain secrets.
#[derive(Debug, Error)]
pub enum Error {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("not authorized: {0}")]
    Forbidden(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("pairing credential rejected: {0}")]
    Pairing(String),
    #[error("signature or integrity check failed: {0}")]
    Integrity(String),
    #[error("unsupported policy schema version {0}")]
    UnsupportedSchema(u32),
    #[error("stale policy revision {got} (current {current})")]
    StaleRevision { got: u64, current: u64 },
    #[error("rate limited, retry in {0}s")]
    RateLimited(u64),
    #[error("admin credential is locked; unlock the class first")]
    Locked,
    #[error("network error: {0}")]
    Network(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn invalid(s: impl Into<String>) -> Self {
        Error::Invalid(s.into())
    }
}
