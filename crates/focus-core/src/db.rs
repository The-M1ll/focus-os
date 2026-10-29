//! SQLite access with versioned, transactional migrations.
//!
//! Classroom data and personal study data live in *separate database files*
//! so that nothing in the classroom protocol can reach private notes.

use crate::error::{Error, Result};
use rusqlite::{Connection, Transaction};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

pub struct Migration {
    pub version: u32,
    pub name: &'static str,
    pub sql: &'static str,
}

pub struct Db {
    conn: Mutex<Connection>,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Db {
    pub fn open(path: &Path, migrations: &[Migration]) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn, migrations, true)
    }

    pub fn open_in_memory(migrations: &[Migration]) -> Result<Self> {
        Self::init(Connection::open_in_memory()?, migrations, false)
    }

    fn init(conn: Connection, migrations: &[Migration], wal: bool) -> Result<Self> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        if wal {
            conn.pragma_update(None, "journal_mode", "WAL")?;
        }
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let db = Db {
            conn: Mutex::new(conn),
        };
        db.migrate(migrations)?;
        Ok(db)
    }

    fn migrate(&self, migrations: &[Migration]) -> Result<()> {
        let mut conn = self.lock();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations(
               version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
        )?;
        let current: u32 = conn.query_row(
            "SELECT COALESCE(MAX(version),0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )?;
        let latest = migrations.iter().map(|m| m.version).max().unwrap_or(0);
        if current > latest {
            // A newer app wrote this database. Refuse rather than risk corrupting it.
            return Err(Error::invalid(format!(
                "database schema v{current} is newer than this app supports (v{latest}); update FOCUS OS"
            )));
        }
        for m in migrations.iter().filter(|m| m.version > current) {
            let tx = conn.transaction()?;
            tx.execute_batch(m.sql)?;
            tx.execute(
                "INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)",
                rusqlite::params![m.version, m.name, now_ms()],
            )?;
            tx.commit()?;
        }
        Ok(())
    }

    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        // A poisoned lock only means another thread panicked mid-operation; SQLite
        // transactions roll back on drop, so the connection itself is still consistent.
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Run `f` inside a transaction; commits only if `f` returns Ok.
    pub fn tx<T>(&self, f: impl FnOnce(&Transaction) -> Result<T>) -> Result<T> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    pub fn schema_version(&self) -> Result<u32> {
        Ok(self.lock().query_row(
            "SELECT COALESCE(MAX(version),0) FROM schema_migrations",
            [],
            |r| r.get(0),
        )?)
    }

    pub fn integrity_check(&self) -> Result<bool> {
        let r: String = self
            .lock()
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        Ok(r == "ok")
    }

    /// Consistent online snapshot into `dest` (which must not exist).
    pub fn backup_to(&self, dest: &Path) -> Result<()> {
        if dest.exists() {
            return Err(Error::invalid("backup destination already exists"));
        }
        let d = dest
            .to_str()
            .ok_or_else(|| Error::invalid("non-utf8 path"))?;
        self.lock().execute("VACUUM INTO ?", [d])?;
        Ok(())
    }
}
