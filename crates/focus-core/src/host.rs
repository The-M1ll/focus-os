//! Classroom authority logic. All privileged decisions are made here (never in the
//! UI or transport): admin checks, pairing, policy publication, audit, transfer.

use crate::crypto::{self, KeyPair, SealedBlob};
use crate::db::{Db, now_ms};
use crate::error::{Error, Result};
use crate::policy::{self, PolicyPayload, SignedPolicy};
use crate::protocol::*;
use crate::ratelimit::RateLimiter;
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use tokio::sync::broadcast;

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The parts of an HTTP request that a device signs (see NETWORK_PROTOCOL.md §Authenticated requests).
#[derive(Clone, Copy)]
pub struct SignedRequest<'a> {
    pub class: &'a str,
    pub device: &'a str,
    pub ts: i64,
    pub nonce: &'a str,
    pub sig: &'a str,
    pub method: &'a str,
    pub path: &'a str,
    pub body: &'a [u8],
}

pub fn system_clock() -> Clock {
    Arc::new(now_ms)
}

pub const MAX_PAIRING_TTL_MS: i64 = 15 * 60_000;

#[derive(Clone, Debug)]
pub enum HostEvent {
    MemberJoined {
        member_id: String,
        name: String,
    },
    MemberRemoved {
        member_id: String,
        device_ids: Vec<String>,
    },
    PolicyPublished {
        revision: u64,
    },
    Acked {
        device_id: String,
        revision: u64,
    },
    Online {
        device_id: String,
        online: bool,
    },
}

#[derive(Serialize, Clone, Debug)]
pub struct Authed {
    pub device_id: String,
    pub member_id: String,
    pub role: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct MemberInfo {
    pub member_id: String,
    pub name: String,
    pub role: String,
    pub status: String,
    pub joined_at: i64,
    pub devices: Vec<DeviceInfo>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DeviceInfo {
    pub device_id: String,
    pub status: String,
    pub last_seen_at: Option<i64>,
    pub acked_revision: u64,
    pub acked_at: Option<i64>,
    pub online: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct HostStatus {
    pub class_id: String,
    pub name: String,
    pub status: String,
    pub unlocked: bool,
    pub current_revision: u64,
    pub member_count: u32,
    pub online_count: u32,
    pub key_id: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct PairingInvite {
    pub pairing_id: String,
    pub token: String,
    pub expires_at: i64,
    pub max_uses: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct CreatedClass {
    pub class_id: String,
    pub member_id: String,
    pub admin_device_id: String,
    /// Admin device secret key (base64url). The caller stores it in `memberships`.
    pub admin_device_secret: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct AuditEntry {
    pub id: i64,
    pub ts: i64,
    pub actor: String,
    pub action: String,
    pub detail: String,
}

pub struct HostService {
    pub db: Arc<Db>,
    pub class_id: String,
    clock: Clock,
    signing: RwLock<Option<KeyPair>>,
    pairings: Mutex<HashMap<String, Vec<u8>>>,
    limiter: RateLimiter,
    online: Mutex<HashMap<String, u32>>,
    policy_tx: broadcast::Sender<SignedPolicy>,
    events_tx: broadcast::Sender<HostEvent>,
    started_at: i64,
}

fn validate_name(n: &str) -> Result<String> {
    let t = n.trim();
    if t.is_empty() || t.chars().count() > 64 || t.chars().any(|c| c.is_control()) {
        return Err(Error::invalid(
            "display name must be 1-64 printable characters",
        ));
    }
    Ok(t.to_string())
}

fn audit(
    tx: &Transaction,
    class_id: &str,
    ts: i64,
    actor: &str,
    action: &str,
    detail: &str,
) -> Result<()> {
    let prev: String = tx
        .query_row(
            "SELECT hash FROM audit_events WHERE class_id=? ORDER BY id DESC LIMIT 1",
            [class_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_else(|| "genesis".into());
    let hash = crypto::sha256_hex(format!("{prev}|{ts}|{actor}|{action}|{detail}").as_bytes());
    tx.execute(
        "INSERT INTO audit_events(class_id,ts,actor,action,detail,prev_hash,hash) VALUES(?,?,?,?,?,?,?)",
        params![class_id, ts, actor, action, detail, prev, hash],
    )?;
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct BundleMember {
    id: String,
    display_name: String,
    role: String,
    status: String,
    joined_at: i64,
}
#[derive(Serialize, Deserialize)]
struct BundleDevice {
    id: String,
    member_id: String,
    public_key: String,
    status: String,
    created_at: i64,
}
#[derive(Serialize, Deserialize)]
struct BundlePolicy {
    revision: u64,
    envelope: String,
    signature: String,
    key_id: String,
    created_at: i64,
}
#[derive(Serialize, Deserialize)]
struct BundleFile {
    format: String,
    class_id: String,
    sealed: SealedBlob,
}
#[derive(Serialize, Deserialize)]
struct Bundle {
    v: u32,
    class_id: String,
    name: String,
    created_at: i64,
    signing_secret: String,
    members: Vec<BundleMember>,
    devices: Vec<BundleDevice>,
    policies: Vec<BundlePolicy>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RestoreMode {
    /// Previous admin handed over voluntarily: their device stays as a plain member.
    Transfer,
    /// Previous admin host is lost: their devices are revoked.
    Recovery,
}

impl HostService {
    // ---- creation / opening ------------------------------------------------

    /// Create a class on this device. Works fully offline.
    pub fn create_class(
        db: &Arc<Db>,
        name: &str,
        admin_name: &str,
        admin_passphrase: &str,
        clock: &Clock,
    ) -> Result<CreatedClass> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 80 {
            return Err(Error::invalid("class name must be 1-80 characters"));
        }
        let admin_name = validate_name(admin_name)?;
        if admin_passphrase.chars().count() < 10 {
            return Err(Error::invalid(
                "administrator passphrase must be at least 10 characters",
            ));
        }
        let class_id = crypto::random_id();
        let key = KeyPair::generate();
        let sealed = crypto::seal(admin_passphrase, &*key.secret_bytes(), class_id.as_bytes())?;
        let dev = KeyPair::generate();
        let member_id = crypto::random_id();
        let now = clock();
        db.tx(|tx| {
            tx.execute(
                "INSERT INTO classes(id,name,created_at,signing_pub,key_id,signing_key_sealed,status) VALUES(?,?,?,?,?,?, 'active')",
                params![class_id, name, now, key.public_b64(), key.key_id(), serde_json::to_string(&sealed).unwrap()],
            )?;
            tx.execute(
                "INSERT INTO members(id,class_id,display_name,role,status,joined_at) VALUES(?,?,?,'admin','active',?)",
                params![member_id, class_id, admin_name, now],
            )?;
            tx.execute(
                "INSERT INTO devices(id,member_id,public_key,status,created_at) VALUES(?,?,?,'active',?)",
                params![dev.key_id(), member_id, dev.public_b64(), now],
            )?;
            tx.execute(
                "INSERT INTO memberships(class_id,class_name,class_pub,key_id,host_addrs,device_secret,device_id,member_id,role,joined_at,status)
                 VALUES(?,?,?,?,?,?,?,?, 'admin', ?, 'active')",
                params![class_id, name, key.public_b64(), key.key_id(), "[]", crypto::b64(&*dev.secret_bytes()), dev.key_id(), member_id, now],
            )?;
            audit(tx, &class_id, now, &dev.key_id(), "class_created", name)?;
            Ok(())
        })?;
        Ok(CreatedClass {
            class_id,
            member_id,
            admin_device_id: dev.key_id(),
            admin_device_secret: crypto::b64(&*dev.secret_bytes()),
        })
    }

    pub fn open(db: Arc<Db>, class_id: &str, clock: Clock) -> Result<Arc<Self>> {
        let status: Option<String> = db
            .lock()
            .query_row("SELECT status FROM classes WHERE id=?", [class_id], |r| {
                r.get(0)
            })
            .optional()?;
        match status.as_deref() {
            None => return Err(Error::NotFound("class".into())),
            Some("active") => {}
            Some(_) => {
                return Err(Error::Forbidden(
                    "this class was transferred to another administrator".into(),
                ));
            }
        }
        let (ptx, _) = broadcast::channel(64);
        let (etx, _) = broadcast::channel(256);
        let started_at = clock();
        Ok(Arc::new(Self {
            db,
            class_id: class_id.to_string(),
            clock,
            signing: RwLock::new(None),
            pairings: Mutex::new(HashMap::new()),
            limiter: RateLimiter::default(),
            online: Mutex::new(HashMap::new()),
            policy_tx: ptx,
            events_tx: etx,
            started_at,
        }))
    }

    pub fn now(&self) -> i64 {
        (self.clock)()
    }
    pub fn started_at(&self) -> i64 {
        self.started_at
    }
    pub fn subscribe_policy(&self) -> broadcast::Receiver<SignedPolicy> {
        self.policy_tx.subscribe()
    }
    pub fn subscribe_events(&self) -> broadcast::Receiver<HostEvent> {
        self.events_tx.subscribe()
    }
    fn emit(&self, e: HostEvent) {
        let _ = self.events_tx.send(e);
    }
    pub fn limiter_check(&self, key: &str, limit: u32, window_ms: i64) -> Result<()> {
        self.limiter.check(key, limit, window_ms, self.now())
    }

    // ---- admin credential --------------------------------------------------

    pub fn is_unlocked(&self) -> bool {
        self.signing
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
    }

    /// Unlock the class signing key. Failed attempts trigger exponential lockout.
    pub fn unlock(&self, passphrase: &str) -> Result<()> {
        let now = self.now();
        let (sealed, failures, locked_until): (String, i64, i64) = self.db.lock().query_row(
            "SELECT signing_key_sealed, unlock_failures, locked_until FROM classes WHERE id=?",
            [&self.class_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if locked_until > now {
            return Err(Error::RateLimited(((locked_until - now) / 1000 + 1) as u64));
        }
        let blob: SealedBlob =
            serde_json::from_str(&sealed).map_err(|_| Error::invalid("corrupt sealed key"))?;
        match crypto::open(passphrase, &blob, self.class_id.as_bytes()) {
            Ok(secret) => {
                let kp = KeyPair::from_secret(&secret)?;
                *self.signing.write().unwrap_or_else(|p| p.into_inner()) = Some(kp);
                self.db.tx(|tx| {
                    tx.execute(
                        "UPDATE classes SET unlock_failures=0, locked_until=0 WHERE id=?",
                        [&self.class_id],
                    )?;
                    audit(tx, &self.class_id, now, "host", "unlocked", "")?;
                    Ok(())
                })
            }
            Err(_) => {
                let f = failures + 1;
                // Free attempts: 3. Then 5s, 10s, 20s ... capped at 15 minutes.
                let lock = if f >= 3 {
                    now + (5_000i64 << (f - 3).min(8)).min(15 * 60_000)
                } else {
                    0
                };
                self.db.tx(|tx| {
                    tx.execute(
                        "UPDATE classes SET unlock_failures=?, locked_until=? WHERE id=?",
                        params![f, lock, self.class_id],
                    )?;
                    audit(
                        tx,
                        &self.class_id,
                        now,
                        "host",
                        "unlock_failed",
                        &format!("attempt {f}"),
                    )?;
                    Ok(())
                })?;
                Err(Error::Forbidden(
                    "incorrect administrator passphrase".into(),
                ))
            }
        }
    }

    pub fn lock(&self) {
        *self.signing.write().unwrap_or_else(|p| p.into_inner()) = None;
        self.pairings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    /// Re-encrypt the signing key under a new passphrase (credential rotation).
    pub fn rotate_passphrase(&self, old: &str, new: &str) -> Result<()> {
        if new.chars().count() < 10 {
            return Err(Error::invalid(
                "administrator passphrase must be at least 10 characters",
            ));
        }
        self.unlock(old)?;
        let secret = {
            let g = self.signing.read().unwrap_or_else(|p| p.into_inner());
            g.as_ref().ok_or(Error::Locked)?.secret_bytes()
        };
        let sealed = crypto::seal(new, &*secret, self.class_id.as_bytes())?;
        let now = self.now();
        self.db.tx(|tx| {
            tx.execute(
                "UPDATE classes SET signing_key_sealed=? WHERE id=?",
                params![serde_json::to_string(&sealed).unwrap(), self.class_id],
            )?;
            audit(tx, &self.class_id, now, "host", "passphrase_rotated", "")?;
            Ok(())
        })
    }

    // ---- authorisation -----------------------------------------------------

    fn device_auth(
        &self,
        conn: &rusqlite::Connection,
        device_id: &str,
    ) -> Result<(Authed, String)> {
        conn.query_row(
            "SELECT d.id, d.member_id, m.role, d.public_key FROM devices d JOIN members m ON m.id=d.member_id
             WHERE d.id=? AND d.status='active' AND m.status='active' AND m.class_id=?",
            params![device_id, self.class_id],
            |r| Ok((Authed { device_id: r.get(0)?, member_id: r.get(1)?, role: r.get(2)? }, r.get::<_, String>(3)?)),
        )
        .optional()?
        .ok_or_else(|| Error::Forbidden("unknown or revoked device".into()))
    }

    /// Authority check used by every privileged operation.
    pub fn require_admin(&self, device_id: &str) -> Result<Authed> {
        let conn = self.db.lock();
        let (a, _) = self.device_auth(&conn, device_id)?;
        if a.role != "admin" {
            return Err(Error::Forbidden("administrator role required".into()));
        }
        Ok(a)
    }

    /// Verify a signed request: device, signature, clock skew, rate limit, replay.
    pub fn authenticate(&self, req: &SignedRequest) -> Result<Authed> {
        let SignedRequest {
            class: class_hdr,
            device,
            ts,
            nonce,
            sig,
            method,
            path,
            body,
        } = *req;
        let now = self.now();
        if class_hdr != self.class_id {
            return Err(Error::Forbidden("wrong class".into()));
        }
        if (now - ts).abs() > REQUEST_SKEW_MS {
            return Err(Error::Forbidden(
                "request timestamp outside allowed window (check device clocks)".into(),
            ));
        }
        if nonce.is_empty() || nonce.len() > 64 {
            return Err(Error::invalid("bad nonce"));
        }
        self.limiter
            .check(&format!("dev:{device}"), 600, 60_000, now)?;
        let (auth, pubkey) = {
            let conn = self.db.lock();
            self.device_auth(&conn, device)?
        };
        let msg = request_message(&self.class_id, method, path, ts, nonce, body);
        crypto::verify(&pubkey, msg.as_bytes(), sig)
            .map_err(|_| Error::Forbidden("bad request signature".into()))?;
        // Only authenticated requests may consume nonce space.
        let key = format!("{device}:{nonce}");
        self.db.tx(|tx| {
            tx.execute("DELETE FROM seen_nonces WHERE expires_at < ?", [now])?;
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO seen_nonces(nonce,expires_at) VALUES(?,?)",
                params![key, now + 2 * REQUEST_SKEW_MS],
            )?;
            if inserted == 0 {
                return Err(Error::Forbidden("replayed request".into()));
            }
            tx.execute(
                "UPDATE devices SET last_seen_at=? WHERE id=?",
                params![now, device],
            )?;
            Ok(())
        })?;
        Ok(auth)
    }

    // ---- pairing -----------------------------------------------------------

    pub fn create_pairing(
        &self,
        actor_device: &str,
        ttl_ms: i64,
        max_uses: u32,
    ) -> Result<PairingInvite> {
        self.require_admin(actor_device)?;
        if !self.is_unlocked() {
            return Err(Error::Locked);
        }
        if ttl_ms <= 0 || ttl_ms > MAX_PAIRING_TTL_MS {
            return Err(Error::invalid(
                "pairing lifetime must be between 1 ms and 15 minutes",
            ));
        }
        if max_uses == 0 || max_uses > 500 {
            return Err(Error::invalid("max_uses must be 1..=500"));
        }
        let id = crypto::random_id();
        let token = crypto::random_bytes::<16>();
        let now = self.now();
        let expires = now + ttl_ms;
        self.db.tx(|tx| {
            tx.execute(
                "INSERT INTO pairing_sessions(id,class_id,created_at,expires_at,max_uses,status) VALUES(?,?,?,?,?, 'open')",
                params![id, self.class_id, now, expires, max_uses],
            )?;
            audit(tx, &self.class_id, now, actor_device, "pairing_created", &format!("max_uses={max_uses}"))
        })?;
        self.pairings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.clone(), token.to_vec());
        Ok(PairingInvite {
            pairing_id: id,
            token: crypto::b64(&token),
            expires_at: expires,
            max_uses,
        })
    }

    pub fn revoke_pairing(&self, actor_device: &str, pairing_id: &str) -> Result<()> {
        self.require_admin(actor_device)?;
        self.pairings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(pairing_id);
        let now = self.now();
        self.db.tx(|tx| {
            tx.execute(
                "UPDATE pairing_sessions SET status='revoked' WHERE id=? AND class_id=?",
                params![pairing_id, self.class_id],
            )?;
            audit(
                tx,
                &self.class_id,
                now,
                actor_device,
                "pairing_revoked",
                pairing_id,
            )
        })
    }

    pub fn join_payload(&self, invite: &PairingInvite, addrs: Vec<String>) -> Result<JoinPayload> {
        let (name, pubk): (String, String) = self.db.lock().query_row(
            "SELECT name, signing_pub FROM classes WHERE id=?",
            [&self.class_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(JoinPayload {
            v: 1,
            class_id: self.class_id.clone(),
            class_name: name,
            class_pub: pubk,
            pairing_id: invite.pairing_id.clone(),
            token: invite.token.clone(),
            addrs,
            expires_at: invite.expires_at,
        })
    }

    pub fn hello(&self) -> Result<Hello> {
        let (name, key_id): (String, String) = self.db.lock().query_row(
            "SELECT name,key_id FROM classes WHERE id=?",
            [&self.class_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(Hello {
            class_id: self.class_id.clone(),
            class_name: name,
            key_id,
            protocol: PROTOCOL_VERSION,
            schemas: policy::SUPPORTED_SCHEMAS.to_vec(),
        })
    }

    /// Process an (unauthenticated) join request carrying a pairing proof.
    pub fn join(&self, req: &JoinRequest, remote: &str) -> Result<JoinResponse> {
        let now = self.now();
        self.limiter
            .check(&format!("join:{remote}"), 20, 60_000, now)?;
        let generic = || Error::Pairing("invalid or expired pairing code".into());
        if req.nonce.is_empty() || req.nonce.len() > 64 || req.display_name.len() > 256 {
            return Err(Error::invalid("malformed join request"));
        }
        let name = validate_name(&req.display_name)?;
        if (now - req.ts).abs() > JOIN_SKEW_MS {
            return Err(Error::Pairing(
                "device clock differs too much from the host".into(),
            ));
        }
        let token = self
            .pairings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&req.pairing_id)
            .cloned()
            .ok_or_else(generic)?;

        let (expires, max_uses, uses, failures, status): (i64, u32, u32, u32, String) = self
            .db
            .lock()
            .query_row(
                "SELECT expires_at,max_uses,uses,failures,status FROM pairing_sessions WHERE id=? AND class_id=?",
                params![req.pairing_id, self.class_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?
            .ok_or_else(generic)?;
        if status != "open" || expires <= now || uses >= max_uses || failures >= 5 {
            return Err(generic());
        }

        let mut msg_req = req.clone();
        msg_req.display_name = req.display_name.clone(); // proof binds the name exactly as sent
        let msg = join_message(&self.class_id, &msg_req);
        let expected = crypto::hmac_b64(&token, msg.as_bytes());
        if !crypto::ct_eq(&expected, &req.proof) {
            self.db.lock().execute(
                "UPDATE pairing_sessions SET failures=failures+1 WHERE id=?",
                [&req.pairing_id],
            )?;
            return Err(generic());
        }
        crypto::verify(&req.device_pub, msg.as_bytes(), &req.device_sig)
            .map_err(|_| Error::Pairing("device key proof invalid".into()))?;
        let device_id = crypto::key_id(&req.device_pub);
        let member_id = crypto::random_id();
        let policy = self.current_policy()?;
        let (class_name, class_pub): (String, String) = self.db.lock().query_row(
            "SELECT name, signing_pub FROM classes WHERE id=?",
            [&self.class_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        self.db.tx(|tx| {
            tx.execute("DELETE FROM seen_nonces WHERE expires_at < ?", [now])?;
            let ins = tx.execute(
                "INSERT OR IGNORE INTO seen_nonces(nonce,expires_at) VALUES(?,?)",
                params![format!("join:{}", req.nonce), now + 2 * JOIN_SKEW_MS],
            )?;
            if ins == 0 {
                return Err(Error::Pairing("replayed join request".into()));
            }
            // Re-check capacity inside the transaction so concurrent joins cannot exceed max_uses.
            let n = tx.execute(
                "UPDATE pairing_sessions SET uses=uses+1 WHERE id=? AND uses<max_uses AND status='open'",
                [&req.pairing_id],
            )?;
            if n == 0 {
                return Err(generic());
            }
            tx.execute(
                "INSERT INTO members(id,class_id,display_name,role,status,joined_at) VALUES(?,?,?,'member','active',?)",
                params![member_id, self.class_id, name, now],
            )?;
            tx.execute(
                "INSERT INTO devices(id,member_id,public_key,status,created_at) VALUES(?,?,?, 'active', ?)",
                params![device_id, member_id, req.device_pub, now],
            )
            .map_err(|e| match e {
                rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                    Error::Pairing("this device is already enrolled".into())
                }
                other => other.into(),
            })?;
            audit(tx, &self.class_id, now, &device_id, "member_joined", &name)
        })?;
        self.emit(HostEvent::MemberJoined {
            member_id: member_id.clone(),
            name,
        });
        let host_proof = crypto::hmac_b64(
            &token,
            host_proof_message(&self.class_id, &req.device_pub, &req.nonce, &member_id).as_bytes(),
        );
        Ok(JoinResponse {
            class_id: self.class_id.clone(),
            class_name,
            class_pub,
            member_id,
            device_id,
            role: "member".into(),
            policy,
            host_proof,
        })
    }

    // ---- policy ------------------------------------------------------------

    pub fn current_policy(&self) -> Result<Option<SignedPolicy>> {
        Ok(self
            .db
            .lock()
            .query_row(
                "SELECT envelope,signature,key_id FROM policy_revisions WHERE class_id=? ORDER BY revision DESC LIMIT 1",
                [&self.class_id],
                |r| Ok(SignedPolicy { envelope: r.get(0)?, signature: r.get(1)?, key_id: r.get(2)? }),
            )
            .optional()?)
    }

    /// Validate, sign, persist transactionally, then notify. Returns the stored policy.
    pub fn publish_policy(
        &self,
        actor_device: &str,
        payload: PolicyPayload,
    ) -> Result<SignedPolicy> {
        self.require_admin(actor_device)?;
        payload.validate()?;
        let now = self.now();
        let sp = {
            let guard = self.signing.read().unwrap_or_else(|p| p.into_inner());
            let key = guard.as_ref().ok_or(Error::Locked)?;
            self.db.tx(|tx| {
                // Unchanged payload: do not burn a revision.
                if let Some(cur) = self.current_policy_tx(tx)?
                    && let Ok(env) = serde_json::from_str::<policy::PolicyEnvelope>(&cur.envelope)
                        && env.payload == payload {
                            return Ok(cur);
                        }
                let current: u64 = tx.query_row("SELECT current_revision FROM classes WHERE id=?", [&self.class_id], |r| r.get::<_, i64>(0))? as u64;
                let rev = current + 1;
                let sp = policy::sign(key, &self.class_id, rev, now, payload.clone())?;
                tx.execute(
                    "INSERT INTO policy_revisions(class_id,revision,envelope,signature,key_id,created_at) VALUES(?,?,?,?,?,?)",
                    params![self.class_id, rev as i64, sp.envelope, sp.signature, sp.key_id, now],
                )?;
                tx.execute("UPDATE classes SET current_revision=? WHERE id=?", params![rev as i64, self.class_id])?;
                audit(tx, &self.class_id, now, actor_device, "policy_published", &format!("revision {rev}"))?;
                Ok(sp)
            })?
        };
        let rev = serde_json::from_str::<policy::PolicyEnvelope>(&sp.envelope)
            .map(|e| e.revision)
            .unwrap_or(0);
        let _ = self.policy_tx.send(sp.clone());
        self.emit(HostEvent::PolicyPublished { revision: rev });
        Ok(sp)
    }

    fn current_policy_tx(&self, tx: &Transaction) -> Result<Option<SignedPolicy>> {
        Ok(tx
            .query_row(
                "SELECT envelope,signature,key_id FROM policy_revisions WHERE class_id=? ORDER BY revision DESC LIMIT 1",
                [&self.class_id],
                |r| Ok(SignedPolicy { envelope: r.get(0)?, signature: r.get(1)?, key_id: r.get(2)? }),
            )
            .optional()?)
    }

    pub fn record_ack(&self, device_id: &str, revision: u64) -> Result<()> {
        let now = self.now();
        let current: i64 = self.db.lock().query_row(
            "SELECT current_revision FROM classes WHERE id=?",
            [&self.class_id],
            |r| r.get(0),
        )?;
        if revision as i64 > current {
            return Err(Error::invalid("acknowledged revision does not exist"));
        }
        self.db.lock().execute(
            "UPDATE devices SET acked_revision=MAX(acked_revision,?), acked_at=? WHERE id=?",
            params![revision as i64, now, device_id],
        )?;
        self.emit(HostEvent::Acked {
            device_id: device_id.to_string(),
            revision,
        });
        Ok(())
    }

    // ---- membership --------------------------------------------------------

    pub fn set_online(&self, device_id: &str, online: bool) {
        let mut m = self.online.lock().unwrap_or_else(|p| p.into_inner());
        let c = m.entry(device_id.to_string()).or_insert(0);
        if online {
            *c += 1;
        } else {
            *c = c.saturating_sub(1);
        }
        let now_online = *c > 0;
        if *c == 0 {
            m.remove(device_id);
        }
        drop(m);
        self.emit(HostEvent::Online {
            device_id: device_id.to_string(),
            online: now_online,
        });
    }

    pub fn list_members(&self, actor_device: &str) -> Result<Vec<MemberInfo>> {
        self.require_admin(actor_device)?;
        let online = self
            .online
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        let conn = self.db.lock();
        let mut st = conn.prepare("SELECT id,display_name,role,status,joined_at FROM members WHERE class_id=? ORDER BY role='admin' DESC, joined_at")?;
        let members: Vec<(String, String, String, String, i64)> = st
            .query_map([&self.class_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<std::result::Result<_, _>>()?;
        let mut out = vec![];
        for (id, name, role, status, joined_at) in members {
            let mut ds = conn.prepare("SELECT id,status,last_seen_at,acked_revision,acked_at FROM devices WHERE member_id=?")?;
            let devices = ds
                .query_map([&id], |r| {
                    let did: String = r.get(0)?;
                    Ok(DeviceInfo {
                        online: online.contains_key(&did),
                        device_id: did,
                        status: r.get(1)?,
                        last_seen_at: r.get(2)?,
                        acked_revision: r.get::<_, i64>(3)? as u64,
                        acked_at: r.get(4)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            out.push(MemberInfo {
                member_id: id,
                name,
                role,
                status,
                joined_at,
                devices,
            });
        }
        Ok(out)
    }

    pub fn remove_member(&self, actor_device: &str, member_id: &str) -> Result<()> {
        self.require_admin(actor_device)?;
        let now = self.now();
        let device_ids = self.db.tx(|tx| {
            let role: Option<String> = tx
                .query_row(
                    "SELECT role FROM members WHERE id=? AND class_id=? AND status='active'",
                    params![member_id, self.class_id],
                    |r| r.get(0),
                )
                .optional()?;
            match role.as_deref() {
                None => return Err(Error::NotFound("member".into())),
                Some("admin") => return Err(Error::Forbidden(
                    "the primary administrator cannot be removed; transfer administration first"
                        .into(),
                )),
                _ => {}
            }
            tx.execute(
                "UPDATE members SET status='removed' WHERE id=?",
                [member_id],
            )?;
            tx.execute(
                "UPDATE devices SET status='revoked' WHERE member_id=?",
                [member_id],
            )?;
            let mut st = tx.prepare("SELECT id FROM devices WHERE member_id=?")?;
            let ids: Vec<String> = st
                .query_map([member_id], |r| r.get(0))?
                .collect::<std::result::Result<_, _>>()?;
            audit(
                tx,
                &self.class_id,
                now,
                actor_device,
                "member_removed",
                member_id,
            )?;
            Ok(ids)
        })?;
        self.emit(HostEvent::MemberRemoved {
            member_id: member_id.to_string(),
            device_ids,
        });
        Ok(())
    }

    pub fn status(&self) -> Result<HostStatus> {
        let conn = self.db.lock();
        let (name, st, rev, key_id): (String, String, i64, String) = conn.query_row(
            "SELECT name,status,current_revision,key_id FROM classes WHERE id=?",
            [&self.class_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        let members: u32 = conn.query_row(
            "SELECT COUNT(*) FROM members WHERE class_id=? AND status='active'",
            [&self.class_id],
            |r| r.get(0),
        )?;
        let online = self.online.lock().unwrap_or_else(|p| p.into_inner()).len() as u32;
        Ok(HostStatus {
            class_id: self.class_id.clone(),
            name,
            status: st,
            unlocked: self.is_unlocked(),
            current_revision: rev as u64,
            member_count: members,
            online_count: online,
            key_id,
        })
    }

    pub fn audit_log(&self, actor_device: &str, limit: u32) -> Result<Vec<AuditEntry>> {
        self.require_admin(actor_device)?;
        let conn = self.db.lock();
        let mut st = conn.prepare("SELECT id,ts,actor,action,detail FROM audit_events WHERE class_id=? ORDER BY id DESC LIMIT ?")?;
        let rows = st
            .query_map(params![self.class_id, limit.min(500)], |r| {
                Ok(AuditEntry {
                    id: r.get(0)?,
                    ts: r.get(1)?,
                    actor: r.get(2)?,
                    action: r.get(3)?,
                    detail: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    /// Recompute the audit hash chain; false means the log was altered.
    pub fn verify_audit_chain(&self) -> Result<bool> {
        let conn = self.db.lock();
        let mut st = conn.prepare("SELECT ts,actor,action,detail,prev_hash,hash FROM audit_events WHERE class_id=? ORDER BY id")?;
        let mut prev = "genesis".to_string();
        let rows = st.query_map([&self.class_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?;
        for row in rows {
            let (ts, actor, action, detail, p, h) = row?;
            let expect =
                crypto::sha256_hex(format!("{prev}|{ts}|{actor}|{action}|{detail}").as_bytes());
            if p != prev || h != expect {
                return Ok(false);
            }
            prev = h;
        }
        Ok(true)
    }

    // ---- transfer & recovery ----------------------------------------------

    fn build_bundle(&self, bundle_passphrase: &str) -> Result<String> {
        if bundle_passphrase.chars().count() < 10 {
            return Err(Error::invalid(
                "bundle passphrase must be at least 10 characters",
            ));
        }
        let secret = {
            let g = self.signing.read().unwrap_or_else(|p| p.into_inner());
            g.as_ref().ok_or(Error::Locked)?.secret_bytes()
        };
        let conn = self.db.lock();
        let (name, created_at): (String, i64) = conn.query_row(
            "SELECT name,created_at FROM classes WHERE id=?",
            [&self.class_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let members = conn
            .prepare("SELECT id,display_name,role,status,joined_at FROM members WHERE class_id=?")?
            .query_map([&self.class_id], |r| {
                Ok(BundleMember {
                    id: r.get(0)?,
                    display_name: r.get(1)?,
                    role: r.get(2)?,
                    status: r.get(3)?,
                    joined_at: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let devices = conn
            .prepare("SELECT d.id,d.member_id,d.public_key,d.status,d.created_at FROM devices d JOIN members m ON m.id=d.member_id WHERE m.class_id=?")?
            .query_map([&self.class_id], |r| Ok(BundleDevice { id: r.get(0)?, member_id: r.get(1)?, public_key: r.get(2)?, status: r.get(3)?, created_at: r.get(4)? }))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let policies = conn
            .prepare("SELECT revision,envelope,signature,key_id,created_at FROM policy_revisions WHERE class_id=? ORDER BY revision")?
            .query_map([&self.class_id], |r| Ok(BundlePolicy { revision: r.get::<_, i64>(0)? as u64, envelope: r.get(1)?, signature: r.get(2)?, key_id: r.get(3)?, created_at: r.get(4)? }))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let b = Bundle {
            v: 1,
            class_id: self.class_id.clone(),
            name,
            created_at,
            signing_secret: crypto::b64(&*secret),
            members,
            devices,
            policies,
        };
        let plain = zeroize::Zeroizing::new(serde_json::to_vec(&b).unwrap());
        let sealed = crypto::seal(
            bundle_passphrase,
            &plain,
            format!("focus-bundle-v1:{}", self.class_id).as_bytes(),
        )?;
        Ok(serde_json::to_string(&BundleFile {
            format: "focus-recovery-v1".into(),
            class_id: self.class_id.clone(),
            sealed,
        })
        .unwrap())
    }

    /// Export an encrypted recovery bundle without changing authority. Store it offline.
    pub fn export_recovery_bundle(
        &self,
        actor_device: &str,
        bundle_passphrase: &str,
    ) -> Result<String> {
        self.require_admin(actor_device)?;
        let out = self.build_bundle(bundle_passphrase)?;
        let now = self.now();
        self.db.tx(|tx| {
            audit(
                tx,
                &self.class_id,
                now,
                actor_device,
                "recovery_bundle_exported",
                "",
            )
        })?;
        Ok(out)
    }

    /// Hand administration to another machine: exports the bundle and permanently
    /// retires this host's authority. The bundle is the only copy of the signing key
    /// that remains usable, so the caller must have saved it before this returns Ok.
    pub fn begin_transfer(&self, actor_device: &str, bundle_passphrase: &str) -> Result<String> {
        self.require_admin(actor_device)?;
        let out = self.build_bundle(bundle_passphrase)?;
        let now = self.now();
        self.db.tx(|tx| {
            tx.execute(
                "UPDATE classes SET status='transferred' WHERE id=?",
                [&self.class_id],
            )?;
            audit(
                tx,
                &self.class_id,
                now,
                actor_device,
                "transfer_started",
                "host authority retired",
            )
        })?;
        self.lock();
        Ok(out)
    }

    /// Import a bundle on the new administrator's device.
    pub fn restore_from_bundle(
        db: &Arc<Db>,
        bundle_json: &str,
        bundle_passphrase: &str,
        new_admin_passphrase: &str,
        new_admin_name: &str,
        mode: RestoreMode,
        clock: &Clock,
    ) -> Result<CreatedClass> {
        if new_admin_passphrase.chars().count() < 10 {
            return Err(Error::invalid(
                "administrator passphrase must be at least 10 characters",
            ));
        }
        let new_admin_name = validate_name(new_admin_name)?;
        let file: BundleFile = serde_json::from_str(bundle_json)
            .map_err(|_| Error::invalid("not a recovery bundle"))?;
        if file.format != "focus-recovery-v1" {
            return Err(Error::invalid("unsupported bundle format"));
        }
        let class_id_hint = file.class_id.clone();
        let plain = crypto::open(
            bundle_passphrase,
            &file.sealed,
            format!("focus-bundle-v1:{class_id_hint}").as_bytes(),
        )
        .map_err(|_| Error::Forbidden("wrong bundle passphrase or corrupted bundle".into()))?;
        let b: Bundle =
            serde_json::from_slice(&plain).map_err(|_| Error::invalid("corrupt bundle"))?;
        if b.v != 1 || b.class_id != class_id_hint {
            return Err(Error::invalid("unsupported or inconsistent bundle"));
        }
        let key = KeyPair::from_secret(&crypto::unb64(&b.signing_secret)?)?;
        let sealed = crypto::seal(
            new_admin_passphrase,
            &*key.secret_bytes(),
            b.class_id.as_bytes(),
        )?;
        let dev = KeyPair::generate();
        let new_member = crypto::random_id();
        let now = clock();
        let exists: Option<String> = db
            .lock()
            .query_row(
                "SELECT status FROM classes WHERE id=?",
                [&b.class_id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.as_deref() == Some("active") {
            return Err(Error::invalid(
                "this class is already active on this device",
            ));
        }
        let max_rev = b.policies.iter().map(|p| p.revision).max().unwrap_or(0);
        db.tx(|tx| {
            if exists.is_some() {
                tx.execute("DELETE FROM classes WHERE id=?", [&b.class_id])?; // cascades old copy
            }
            tx.execute(
                "INSERT INTO classes(id,name,created_at,signing_pub,key_id,signing_key_sealed,status,current_revision) VALUES(?,?,?,?,?,?, 'active', ?)",
                params![b.class_id, b.name, b.created_at, key.public_b64(), key.key_id(), serde_json::to_string(&sealed).unwrap(), max_rev as i64],
            )?;
            for m in &b.members {
                // Old admin becomes a plain member (transfer) or is removed (recovery); the unique admin index
                // is satisfied because the new admin is inserted only after demotion.
                let (role, status) = if m.role == "admin" {
                    match mode {
                        RestoreMode::Transfer => ("member", m.status.as_str()),
                        RestoreMode::Recovery => ("member", "removed"),
                    }
                } else {
                    ("member", m.status.as_str())
                };
                tx.execute(
                    "INSERT INTO members(id,class_id,display_name,role,status,joined_at) VALUES(?,?,?,?,?,?)",
                    params![m.id, b.class_id, m.display_name, role, status, m.joined_at],
                )?;
            }
            for d in &b.devices {
                let old_admin_recovered = mode == RestoreMode::Recovery
                    && b.members.iter().any(|m| m.id == d.member_id && m.role == "admin");
                let status = if old_admin_recovered { "revoked" } else { d.status.as_str() };
                tx.execute(
                    "INSERT INTO devices(id,member_id,public_key,status,created_at) VALUES(?,?,?,?,?)",
                    params![d.id, d.member_id, d.public_key, status, d.created_at],
                )?;
            }
            for p in &b.policies {
                tx.execute(
                    "INSERT INTO policy_revisions(class_id,revision,envelope,signature,key_id,created_at) VALUES(?,?,?,?,?,?)",
                    params![b.class_id, p.revision as i64, p.envelope, p.signature, p.key_id, p.created_at],
                )?;
            }
            tx.execute(
                "INSERT INTO members(id,class_id,display_name,role,status,joined_at) VALUES(?,?,?,'admin','active',?)",
                params![new_member, b.class_id, new_admin_name, now],
            )?;
            tx.execute(
                "INSERT INTO devices(id,member_id,public_key,status,created_at) VALUES(?,?,?,'active',?)",
                params![dev.key_id(), new_member, dev.public_b64(), now],
            )?;
            tx.execute("DELETE FROM memberships WHERE class_id=?", [&b.class_id])?;
            tx.execute(
                "INSERT INTO memberships(class_id,class_name,class_pub,key_id,host_addrs,device_secret,device_id,member_id,role,joined_at,status,last_revision)
                 VALUES(?,?,?,?,?,?,?,?, 'admin', ?, 'active', ?)",
                params![b.class_id, b.name, key.public_b64(), key.key_id(), "[]", crypto::b64(&*dev.secret_bytes()), dev.key_id(), new_member, now, max_rev as i64],
            )?;
            let action = if mode == RestoreMode::Transfer { "admin_transferred_in" } else { "admin_recovered" };
            audit(tx, &b.class_id, now, &dev.key_id(), action, &new_admin_name)
        })?;
        Ok(CreatedClass {
            class_id: b.class_id,
            member_id: new_member,
            admin_device_id: dev.key_id(),
            admin_device_secret: crypto::b64(&*dev.secret_bytes()),
        })
    }
}
