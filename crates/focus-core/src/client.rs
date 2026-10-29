//! Member-side logic: building join requests, verifying and persisting policies.
//! Network loops live in `sync`.

use crate::crypto::{self, KeyPair};
use crate::db::Db;
use crate::error::{Error, Result};
use crate::policy::{self, PolicyEnvelope, SignedPolicy};
use crate::protocol::*;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

pub fn build_join_request(
    payload: &JoinPayload,
    display_name: &str,
    device: &KeyPair,
    now: i64,
) -> JoinRequest {
    let mut r = JoinRequest {
        pairing_id: payload.pairing_id.clone(),
        device_pub: device.public_b64(),
        display_name: display_name.to_string(),
        ts: now,
        nonce: crypto::random_id(),
        proof: String::new(),
        device_sig: String::new(),
    };
    let msg = join_message(&payload.class_id, &r);
    let token = crypto::unb64(&payload.token).unwrap_or_default();
    r.proof = crypto::hmac_b64(&token, msg.as_bytes());
    r.device_sig = device.sign(msg.as_bytes());
    r
}

/// Validate the host's answer to a join request before trusting anything in it.
pub fn verify_join_response(
    payload: &JoinPayload,
    req: &JoinRequest,
    resp: &JoinResponse,
) -> Result<Option<PolicyEnvelope>> {
    if resp.class_id != payload.class_id || resp.class_pub != payload.class_pub {
        return Err(Error::Integrity(
            "host presented a different class identity than the join code".into(),
        ));
    }
    let token = crypto::unb64(&payload.token)?;
    let expected = crypto::hmac_b64(
        &token,
        host_proof_message(
            &payload.class_id,
            &req.device_pub,
            &req.nonce,
            &resp.member_id,
        )
        .as_bytes(),
    );
    if !crypto::ct_eq(&expected, &resp.host_proof) {
        return Err(Error::Integrity(
            "host could not prove knowledge of the pairing secret".into(),
        ));
    }
    match &resp.policy {
        Some(p) => Ok(Some(policy::verify(
            p,
            &payload.class_pub,
            &payload.class_id,
        )?)),
        None => Ok(None),
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Membership {
    pub class_id: String,
    pub class_name: String,
    pub class_pub: String,
    pub key_id: String,
    pub host_addrs: Vec<String>,
    pub device_id: String,
    pub member_id: String,
    pub role: String,
    pub joined_at: i64,
    pub last_sync_at: Option<i64>,
    pub last_revision: u64,
    pub status: String,
}

pub fn save_membership(
    db: &Db,
    payload: &JoinPayload,
    resp: &JoinResponse,
    device: &KeyPair,
    now: i64,
    policy: Option<&SignedPolicy>,
) -> Result<()> {
    db.tx(|tx| {
        tx.execute(
            "INSERT OR REPLACE INTO memberships(class_id,class_name,class_pub,key_id,host_addrs,device_secret,device_id,member_id,role,joined_at,status)
             VALUES(?,?,?,?,?,?,?,?,?,?, 'active')",
            params![
                payload.class_id,
                resp.class_name,
                payload.class_pub,
                crypto::key_id(&payload.class_pub),
                serde_json::to_string(&payload.addrs).unwrap(),
                crypto::b64(&*device.secret_bytes()),
                resp.device_id,
                resp.member_id,
                resp.role,
                now
            ],
        )?;
        if let Some(p) = policy {
            store_policy(tx, &payload.class_id, p, now)?;
        }
        Ok(())
    })
}

fn store_policy(
    tx: &rusqlite::Transaction,
    class_id: &str,
    sp: &SignedPolicy,
    now: i64,
) -> Result<()> {
    let env: PolicyEnvelope =
        serde_json::from_str(&sp.envelope).map_err(|_| Error::invalid("malformed policy"))?;
    tx.execute(
        "INSERT INTO client_policies(class_id,revision,envelope,signature,received_at) VALUES(?,?,?,?,?)",
        params![class_id, env.revision as i64, sp.envelope, sp.signature, now],
    )?;
    tx.execute(
        "UPDATE memberships SET last_revision=?, last_sync_at=? WHERE class_id=?",
        params![env.revision as i64, now, class_id],
    )?;
    // Keep a short history (current + previous 9).
    tx.execute(
        "DELETE FROM client_policies WHERE class_id=? AND revision <= ?",
        params![class_id, env.revision as i64 - 10],
    )?;
    Ok(())
}

pub fn load_membership(db: &Db, class_id: &str) -> Result<Membership> {
    db.lock()
        .query_row(
            "SELECT class_id,class_name,class_pub,key_id,host_addrs,device_id,member_id,role,joined_at,last_sync_at,last_revision,status FROM memberships WHERE class_id=?",
            [class_id],
            |r| {
                let addrs: String = r.get(4)?;
                Ok(Membership {
                    class_id: r.get(0)?,
                    class_name: r.get(1)?,
                    class_pub: r.get(2)?,
                    key_id: r.get(3)?,
                    host_addrs: serde_json::from_str(&addrs).unwrap_or_default(),
                    device_id: r.get(5)?,
                    member_id: r.get(6)?,
                    role: r.get(7)?,
                    joined_at: r.get(8)?,
                    last_sync_at: r.get(9)?,
                    last_revision: r.get::<_, i64>(10)? as u64,
                    status: r.get(11)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| Error::NotFound("membership".into()))
}

pub fn list_memberships(db: &Db) -> Result<Vec<Membership>> {
    let ids: Vec<String> = {
        let conn = db.lock();
        let mut st = conn.prepare("SELECT class_id FROM memberships ORDER BY joined_at")?;
        st.query_map([], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?
    };
    ids.iter().map(|id| load_membership(db, id)).collect()
}

pub fn device_key(db: &Db, class_id: &str) -> Result<KeyPair> {
    let s: String = db
        .lock()
        .query_row(
            "SELECT device_secret FROM memberships WHERE class_id=?",
            [class_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| Error::NotFound("membership".into()))?;
    KeyPair::from_secret(&crypto::unb64(&s)?)
}

pub fn set_host_addrs(db: &Db, class_id: &str, addrs: &[String]) -> Result<()> {
    if addrs.is_empty() || addrs.len() > 8 {
        return Err(Error::invalid("provide 1-8 host addresses"));
    }
    db.lock().execute(
        "UPDATE memberships SET host_addrs=? WHERE class_id=?",
        params![serde_json::to_string(addrs).unwrap(), class_id],
    )?;
    Ok(())
}

pub fn mark_removed(db: &Db, class_id: &str) -> Result<()> {
    db.lock().execute(
        "UPDATE memberships SET status='removed' WHERE class_id=?",
        [class_id],
    )?;
    Ok(())
}

pub fn leave_class(db: &Db, class_id: &str) -> Result<()> {
    db.lock()
        .execute("DELETE FROM memberships WHERE class_id=?", [class_id])?;
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub enum ApplyOutcome {
    Applied(u64),
    /// Same revision already stored; nothing changed.
    Duplicate(u64),
}

/// Verify against the pinned key and persist atomically. Older or equal revisions
/// never overwrite newer state.
pub fn apply_policy(db: &Db, class_id: &str, sp: &SignedPolicy, now: i64) -> Result<ApplyOutcome> {
    let m = load_membership(db, class_id)?;
    if m.status != "active" {
        return Err(Error::Forbidden("membership is no longer active".into()));
    }
    let env = policy::verify(sp, &m.class_pub, class_id)?;
    db.tx(|tx| {
        let cur: i64 = tx.query_row(
            "SELECT last_revision FROM memberships WHERE class_id=?",
            [class_id],
            |r| r.get(0),
        )?;
        let cur = cur as u64;
        if env.revision == cur {
            return Ok(ApplyOutcome::Duplicate(cur));
        }
        if env.revision < cur {
            return Err(Error::StaleRevision {
                got: env.revision,
                current: cur,
            });
        }
        store_policy(tx, class_id, sp, now)?;
        Ok(ApplyOutcome::Applied(env.revision))
    })
}

pub fn current_policy(db: &Db, class_id: &str) -> Result<Option<(PolicyEnvelope, i64)>> {
    let row: Option<(String, i64)> = db
        .lock()
        .query_row(
            "SELECT envelope, received_at FROM client_policies WHERE class_id=? ORDER BY revision DESC LIMIT 1",
            [class_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    Ok(row.and_then(|(e, t)| serde_json::from_str(&e).ok().map(|env| (env, t))))
}
