//! Personal study store. Lives in its OWN SQLite file, never shared with classroom code paths.
//! Documents are JSON validated by the frontend (Zod); the native layer enforces size, shape,
//! transactions, integrity checks, backup and restore.

use crate::db::{Db, Migration, now_ms};
use crate::error::{Error, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const PERSONAL_MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "documents",
        sql: include_str!("../migrations/personal_001_documents.sql"),
    },
    Migration {
        version: 2,
        name: "measured_usage",
        sql: include_str!("../migrations/personal_002_usage.sql"),
    },
];

pub const MAX_DOC_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_BATCH: usize = 500;
pub const EXPORT_FORMAT: &str = "focus-os-export-v1";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Doc {
    pub collection: String,
    pub id: String,
    pub json: String,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum WriteOp {
    Put {
        collection: String,
        id: String,
        json: String,
    },
    Delete {
        collection: String,
        id: String,
    },
}

fn check_name(s: &str, what: &str) -> Result<()> {
    if s.is_empty()
        || s.len() > 64
        || !s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' || c == ':')
    {
        return Err(Error::invalid(format!("invalid {what}")));
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MeasuredUsage {
    pub day: String,
    pub platform: String,
    pub source: String,
    pub seconds: u64,
    pub updated_at: i64,
}

pub struct PersonalStore {
    pub db: Db,
}

impl PersonalStore {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            db: Db::open(path, PERSONAL_MIGRATIONS)?,
        })
    }
    pub fn open_in_memory() -> Result<Self> {
        Ok(Self {
            db: Db::open_in_memory(PERSONAL_MIGRATIONS)?,
        })
    }

    pub fn get_all(&self, collection: &str) -> Result<Vec<Doc>> {
        check_name(collection, "collection")?;
        let conn = self.db.lock();
        let mut st = conn.prepare("SELECT collection,id,json,updated_at FROM documents WHERE collection=? ORDER BY updated_at, id")?;
        let rows = st
            .query_map([collection], |r| {
                Ok(Doc {
                    collection: r.get(0)?,
                    id: r.get(1)?,
                    json: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    /// Atomic multi-document write. Either every op applies or none does.
    pub fn write(&self, ops: &[WriteOp]) -> Result<i64> {
        if ops.len() > MAX_BATCH {
            return Err(Error::invalid("batch too large"));
        }
        let now = now_ms();
        self.db.tx(|tx| {
            for op in ops {
                match op {
                    WriteOp::Put { collection, id, json } => {
                        check_name(collection, "collection")?;
                        check_name(id, "id")?;
                        if json.len() > MAX_DOC_BYTES {
                            return Err(Error::invalid("document too large"));
                        }
                        serde_json::from_str::<serde_json::Value>(json).map_err(|_| Error::invalid("document is not valid JSON"))?;
                        tx.execute(
                            "INSERT INTO documents(collection,id,json,updated_at) VALUES(?,?,?,?)
                             ON CONFLICT(collection,id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
                            params![collection, id, json, now],
                        )?;
                    }
                    WriteOp::Delete { collection, id } => {
                        check_name(collection, "collection")?;
                        check_name(id, "id")?;
                        tx.execute("DELETE FROM documents WHERE collection=? AND id=?", params![collection, id])?;
                    }
                }
            }
            Ok(now)
        })
    }

    /// Whole-store export as JSON. Contains everything the user owns; never includes classroom keys.
    pub fn export_json(&self) -> Result<String> {
        let conn = self.db.lock();
        let mut st = conn.prepare(
            "SELECT collection,id,json,updated_at FROM documents ORDER BY collection,id",
        )?;
        let docs: Vec<Doc> = st
            .query_map([], |r| {
                Ok(Doc {
                    collection: r.get(0)?,
                    id: r.get(1)?,
                    json: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(serde_json::json!({ "format": EXPORT_FORMAT, "exported_at": now_ms(), "documents": docs }).to_string())
    }

    /// Validate an export fully *before* touching the store, then replace atomically.
    pub fn import_json(&self, text: &str, replace: bool) -> Result<usize> {
        if text.len() > 64 * 1024 * 1024 {
            return Err(Error::invalid("import file too large"));
        }
        #[derive(Deserialize)]
        struct File {
            format: String,
            documents: Vec<Doc>,
        }
        let f: File = serde_json::from_str(text)
            .map_err(|e| Error::invalid(format!("not a FOCUS OS export: {e}")))?;
        if f.format != EXPORT_FORMAT {
            return Err(Error::invalid("unsupported export format"));
        }
        for d in &f.documents {
            check_name(&d.collection, "collection")?;
            check_name(&d.id, "id")?;
            if d.json.len() > MAX_DOC_BYTES
                || serde_json::from_str::<serde_json::Value>(&d.json).is_err()
            {
                return Err(Error::invalid(format!(
                    "invalid document {}/{}",
                    d.collection, d.id
                )));
            }
        }
        let n = f.documents.len();
        self.db.tx(|tx| {
            if replace {
                tx.execute("DELETE FROM documents", [])?;
            }
            for d in &f.documents {
                tx.execute(
                    "INSERT INTO documents(collection,id,json,updated_at) VALUES(?,?,?,?)
                     ON CONFLICT(collection,id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at",
                    params![d.collection, d.id, d.json, d.updated_at],
                )?;
            }
            Ok(())
        })?;
        Ok(n)
    }

    /// Add `seconds` of extension-measured time. Idempotent per `(report_id)` is handled by the caller.
    pub fn add_measured_usage(&self, day: &str, platform: &str, seconds: u32) -> Result<()> {
        let ok_day = day.len() == 10
            && day.chars().enumerate().all(|(i, c)| {
                if i == 4 || i == 7 {
                    c == '-'
                } else {
                    c.is_ascii_digit()
                }
            });
        if !ok_day {
            return Err(Error::invalid("day must be YYYY-MM-DD"));
        }
        check_name(platform, "platform")?;
        if seconds > 3600 {
            return Err(Error::invalid(
                "a single usage report cannot exceed one hour",
            ));
        }
        self.db.lock().execute(
            "INSERT INTO measured_usage(day,platform,source,seconds,updated_at) VALUES(?,?, 'browser_extension', ?, ?)
             ON CONFLICT(day,platform,source) DO UPDATE SET seconds=seconds+excluded.seconds, updated_at=excluded.updated_at",
            params![day, platform, seconds, now_ms()],
        )?;
        Ok(())
    }

    pub fn measured_usage(&self, from_day: &str, to_day: &str) -> Result<Vec<MeasuredUsage>> {
        let conn = self.db.lock();
        let mut st = conn.prepare("SELECT day,platform,source,seconds,updated_at FROM measured_usage WHERE day BETWEEN ? AND ? ORDER BY day,platform")?;
        let rows = st
            .query_map(params![from_day, to_day], |r| {
                Ok(MeasuredUsage {
                    day: r.get(0)?,
                    platform: r.get(1)?,
                    source: r.get(2)?,
                    seconds: r.get::<_, i64>(3)? as u64,
                    updated_at: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    pub fn backup_to(&self, dest: &Path) -> Result<()> {
        self.db.backup_to(dest)?;
        // Verify the copy opens and passes integrity_check before reporting success.
        let copy = Db::open(dest, PERSONAL_MIGRATIONS)?;
        if !copy.integrity_check()? {
            let _ = std::fs::remove_file(dest);
            return Err(Error::invalid(
                "backup failed its integrity check and was discarded",
            ));
        }
        Ok(())
    }

    /// Verify a backup file, then return a store opened on it (caller swaps files).
    pub fn verify_backup(path: &Path) -> Result<usize> {
        let b = Db::open(path, PERSONAL_MIGRATIONS)?;
        if !b.integrity_check()? {
            return Err(Error::invalid("backup is corrupted"));
        }
        let n: i64 = b
            .lock()
            .query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))?;
        Ok(n as usize)
    }
}
