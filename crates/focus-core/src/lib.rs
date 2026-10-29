pub mod bridge;
pub mod client;
pub mod crypto;
pub mod db;
pub mod discovery;
pub mod error;
pub mod host;
pub mod netinfo;
pub mod personal;
pub mod policy;
pub mod protocol;
pub mod ratelimit;
pub mod server;
pub mod sync;

pub use error::{Error, Result};

pub const CLASSROOM_MIGRATIONS: &[db::Migration] = &[db::Migration {
    version: 1,
    name: "init",
    sql: include_str!("../migrations/classroom_001_init.sql"),
}];
