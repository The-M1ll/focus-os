//! Member-side networking: joining a class and keeping policy in sync.
//! Status reported here is *measured* (what actually happened on the wire).

use crate::client::{self, ApplyOutcome, Membership};
use crate::crypto::{self, KeyPair};
use crate::db::{Db, now_ms};
use crate::error::{Error, Result};
use crate::protocol::*;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, watch};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SyncState {
    Idle,
    Connecting,
    /// Websocket established; live updates are flowing.
    Live,
    /// Host cannot be reached right now. Last stored policy remains in force.
    Offline {
        reason: String,
    },
    /// The host reports this device was removed.
    Removed,
    /// Host sent something this app cannot or will not accept.
    Rejected {
        reason: String,
    },
}

#[derive(Serialize, Clone, Debug)]
pub struct SyncStatus {
    #[serde(flatten)]
    pub state: SyncState,
    pub last_sync_at: Option<i64>,
    pub last_revision: u64,
    pub host: Option<String>,
}

fn http() -> reqwest::Client {
    // `no_proxy`: classroom hosts are on the local network and must never be sent via a proxy.
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(6))
        .connect_timeout(Duration::from_secs(3))
        .build()
        .expect("http client")
}

fn explain_unreachable(addrs: &[String], e: &str) -> Error {
    Error::Network(format!(
        "could not reach the class host at {} ({e}). Check that both devices are on the same Wi-Fi/LAN, the host app is running, \
         and the network does not isolate clients (guest Wi-Fi often does).",
        addrs.join(", ")
    ))
}

async fn error_from_response(resp: reqwest::Response) -> Error {
    let status = resp.status();
    match resp.json::<ErrorBody>().await {
        Ok(b) => match b.code.as_str() {
            "pairing" | "forbidden" | "integrity" => Error::Forbidden(b.error),
            "rate_limited" => Error::RateLimited(5),
            "invalid" => Error::Invalid(b.error),
            _ => Error::Network(format!("host answered {status}: {}", b.error)),
        },
        Err(_) => Error::Network(format!("host answered {status}")),
    }
}

/// Join a class from a scanned/pasted code. Verifies the host before persisting anything.
pub async fn join_class(
    db: &Arc<Db>,
    payload: &JoinPayload,
    display_name: &str,
) -> Result<Membership> {
    if payload.expires_at <= now_ms() {
        return Err(Error::Pairing(
            "this join code has expired; ask the administrator for a new one".into(),
        ));
    }
    let existing = client::load_membership(db, &payload.class_id).ok();
    if existing.as_ref().is_some_and(|m| m.status == "active") {
        return Err(Error::invalid(
            "this device is already a member of that class",
        ));
    }
    let device = KeyPair::generate();
    let req = client::build_join_request(payload, display_name, &device, now_ms());
    let body = serde_json::to_vec(&req).unwrap();
    let c = http();
    let mut last_err = String::new();
    for addr in &payload.addrs {
        match c
            .post(format!("http://{addr}/v1/join"))
            .header("content-type", "application/json")
            .body(body.clone())
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                let r: JoinResponse = resp.json().await.map_err(|_| {
                    Error::Integrity("host sent an unreadable join response".into())
                })?;
                client::verify_join_response(payload, &req, &r)?;
                let now = now_ms();
                client::save_membership(db, payload, &r, &device, now, r.policy.as_ref())?;
                return client::load_membership(db, &payload.class_id);
            }
            Ok(resp) => return Err(error_from_response(resp).await),
            Err(e) => last_err = e.to_string(),
        }
    }
    Err(explain_unreachable(&payload.addrs, &last_err))
}

pub fn signed_headers(
    class_id: &str,
    key: &KeyPair,
    method: &str,
    path: &str,
    body: &[u8],
) -> Vec<(&'static str, String)> {
    let ts = now_ms();
    let nonce = crypto::random_id();
    let sig = key.sign(request_message(class_id, method, path, ts, &nonce, body).as_bytes());
    vec![
        (H_DEVICE, key.key_id()),
        (H_CLASS, class_id.to_string()),
        (H_TS, ts.to_string()),
        (H_NONCE, nonce),
        (H_SIG, sig),
    ]
}

pub struct ClassSync {
    db: Arc<Db>,
    class_id: String,
    status: watch::Sender<SyncStatus>,
    updates: broadcast::Sender<u64>,
}

impl ClassSync {
    pub fn new(db: Arc<Db>, class_id: &str) -> Result<Arc<Self>> {
        let m = client::load_membership(&db, class_id)?;
        let (status, _) = watch::channel(SyncStatus {
            state: if m.status == "removed" {
                SyncState::Removed
            } else {
                SyncState::Idle
            },
            last_sync_at: m.last_sync_at,
            last_revision: m.last_revision,
            host: None,
        });
        let (updates, _) = broadcast::channel(16);
        Ok(Arc::new(Self {
            db,
            class_id: class_id.to_string(),
            status,
            updates,
        }))
    }

    pub fn status(&self) -> SyncStatus {
        self.status.borrow().clone()
    }
    pub fn watch_status(&self) -> watch::Receiver<SyncStatus> {
        self.status.subscribe()
    }
    /// Emits the revision number every time a *new* policy was applied.
    pub fn subscribe_updates(&self) -> broadcast::Receiver<u64> {
        self.updates.subscribe()
    }

    fn set(&self, state: SyncState, host: Option<String>) {
        let m = client::load_membership(&self.db, &self.class_id).ok();
        self.status.send_replace(SyncStatus {
            state,
            last_sync_at: m.as_ref().and_then(|m| m.last_sync_at),
            last_revision: m.as_ref().map(|m| m.last_revision).unwrap_or(0),
            host,
        });
    }

    fn apply(&self, sp: &crate::policy::SignedPolicy) -> Result<ApplyOutcome> {
        let out = client::apply_policy(&self.db, &self.class_id, sp, now_ms())?;
        if let ApplyOutcome::Applied(r) = out {
            let _ = self.updates.send(r);
        }
        Ok(out)
    }

    /// One-shot HTTP sync ("Sync now"). Also refreshes `last_sync_at` when already current.
    pub async fn fetch_once(&self) -> Result<ApplyOutcome> {
        let m = client::load_membership(&self.db, &self.class_id)?;
        let key = client::device_key(&self.db, &self.class_id)?;
        let c = http();
        let mut last_err = String::new();
        for addr in &m.host_addrs {
            let mut rb = c.get(format!("http://{addr}/v1/policy"));
            for (k, v) in signed_headers(&self.class_id, &key, "GET", "/v1/policy", b"") {
                rb = rb.header(k, v);
            }
            match rb.send().await {
                Ok(r) if r.status().is_success() => {
                    let pr: PolicyResponse = r
                        .json()
                        .await
                        .map_err(|_| Error::Integrity("unreadable policy response".into()))?;
                    return match pr.policy {
                        Some(p) => {
                            let out = self.apply(&p);
                            self.set(SyncState::Idle, Some(addr.clone()));
                            out
                        }
                        None => Ok(ApplyOutcome::Duplicate(0)),
                    };
                }
                Ok(r) => {
                    let e = error_from_response(r).await;
                    if matches!(e, Error::Forbidden(_)) {
                        // Do not treat a transient clock skew as removal: only the live loop marks removal.
                        return Err(e);
                    }
                    return Err(e);
                }
                Err(e) => last_err = e.to_string(),
            }
        }
        Err(explain_unreachable(&m.host_addrs, &last_err))
    }

    /// Ask the local network where this class's host is now (mDNS, filtered to our class id) and update the
    /// stored address if it changed. Discovery only supplies an *address*: every request is still signed and
    /// every policy is still verified against the pinned class key, so a rogue advertiser cannot feed us rules.
    async fn rediscover(&self) -> bool {
        let id = self.class_id.clone();
        let found = tokio::task::spawn_blocking(move || {
            crate::discovery::browse(Duration::from_secs(2), Some(&id))
        })
        .await;
        let Ok(Ok(list)) = found else { return false };
        let Some(h) = list.into_iter().next() else {
            return false;
        };
        match client::load_membership(&self.db, &self.class_id) {
            Ok(m) if m.host_addrs != h.addrs => {
                client::set_host_addrs(&self.db, &self.class_id, &h.addrs).is_ok()
            }
            _ => false,
        }
    }

    /// Runs until `cancel` flips to true: connect, receive, reconnect with backoff.
    pub async fn run(self: Arc<Self>, mut cancel: watch::Receiver<bool>) {
        let mut backoff = Duration::from_millis(500);
        let mut failures = 0u32;
        let mut last_discovery = std::time::Instant::now() - Duration::from_secs(3600);
        loop {
            if *cancel.borrow() {
                break;
            }
            let outcome = tokio::select! {
                _ = async { let _ = cancel.wait_for(|v| *v).await; } => break,
                o = self.session() => o,
            };
            match outcome {
                SessionEnd::Removed => {
                    let _ = client::mark_removed(&self.db, &self.class_id);
                    self.set(SyncState::Removed, None);
                    break;
                }
                SessionEnd::Fatal(reason) => {
                    self.set(SyncState::Rejected { reason }, None);
                    // Keep trying slowly: the administrator may publish a compatible policy later.
                    backoff = Duration::from_secs(30);
                }
                SessionEnd::Disconnected { was_live, reason } => {
                    self.set(SyncState::Offline { reason }, None);
                    if was_live {
                        backoff = Duration::from_millis(500);
                        failures = 0;
                    } else {
                        failures += 1;
                    }
                    // The host may have a new address (DHCP, reconnect). After a few failures look for it,
                    // at most once a minute, and retry immediately if the address changed.
                    if failures >= 3 && last_discovery.elapsed() > Duration::from_secs(60) {
                        last_discovery = std::time::Instant::now();
                        if self.rediscover().await {
                            failures = 0;
                            backoff = Duration::from_millis(200);
                        }
                    }
                }
            }
            tokio::select! {
                _ = async { let _ = cancel.wait_for(|v| *v).await; } => break,
                _ = tokio::time::sleep(backoff) => {}
            }
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    }

    async fn session(&self) -> SessionEnd {
        let m = match client::load_membership(&self.db, &self.class_id) {
            Ok(m) => m,
            Err(e) => return SessionEnd::Fatal(e.to_string()),
        };
        let key = match client::device_key(&self.db, &self.class_id) {
            Ok(k) => k,
            Err(e) => return SessionEnd::Fatal(e.to_string()),
        };
        self.set(SyncState::Connecting, None);
        let mut last_reason = "no host address configured".to_string();
        for addr in &m.host_addrs {
            let mut req = match format!("ws://{addr}/v1/live").into_client_request() {
                Ok(r) => r,
                Err(e) => {
                    last_reason = e.to_string();
                    continue;
                }
            };
            for (k, v) in signed_headers(&self.class_id, &key, "GET", "/v1/live", b"") {
                req.headers_mut().insert(k, v.parse().unwrap());
            }
            let cfg = WebSocketConfig::default()
                .max_message_size(Some(MAX_WS_MESSAGE_BYTES))
                .max_frame_size(Some(MAX_WS_MESSAGE_BYTES));
            let conn = tokio::time::timeout(
                Duration::from_secs(5),
                tokio_tungstenite::connect_async_with_config(req, Some(cfg), false),
            )
            .await;
            let (mut ws, _) = match conn {
                Err(_) => {
                    last_reason = format!("timed out connecting to {addr}");
                    continue;
                }
                Ok(Err(tokio_tungstenite::tungstenite::Error::Http(resp))) => {
                    if resp.status() == 403 {
                        // Distinguish "removed" from transient auth problems by asking the verified error body.
                        let body = resp
                            .body()
                            .as_ref()
                            .map(|b| String::from_utf8_lossy(b).to_string())
                            .unwrap_or_default();
                        if body.contains("unknown or revoked device") {
                            return SessionEnd::Removed;
                        }
                        return SessionEnd::Disconnected {
                            was_live: false,
                            reason: format!("host refused the connection: {body}"),
                        };
                    }
                    last_reason = format!("host answered {}", resp.status());
                    continue;
                }
                Ok(Err(e)) => {
                    last_reason = e.to_string();
                    continue;
                }
                Ok(Ok(v)) => v,
            };
            self.set(SyncState::Live, Some(addr.clone()));
            loop {
                match tokio::time::timeout(Duration::from_secs(60), ws.next()).await {
                    Err(_) => {
                        return SessionEnd::Disconnected {
                            was_live: true,
                            reason: "host stopped responding".into(),
                        };
                    }
                    Ok(None) | Ok(Some(Err(_))) | Ok(Some(Ok(Message::Close(_)))) => {
                        return SessionEnd::Disconnected {
                            was_live: true,
                            reason: "connection to host closed".into(),
                        };
                    }
                    Ok(Some(Ok(Message::Text(t)))) => {
                        match serde_json::from_str::<ServerMsg>(t.as_str()) {
                            Ok(ServerMsg::Policy { policy }) => match self.apply(&policy) {
                                Ok(ApplyOutcome::Applied(r)) | Ok(ApplyOutcome::Duplicate(r)) => {
                                    self.set(SyncState::Live, Some(addr.clone()));
                                    let ack =
                                        serde_json::to_string(&ClientMsg::Ack { revision: r })
                                            .unwrap();
                                    if ws.send(Message::Text(ack.into())).await.is_err() {
                                        return SessionEnd::Disconnected {
                                            was_live: true,
                                            reason: "connection lost".into(),
                                        };
                                    }
                                }
                                Err(Error::StaleRevision { .. }) => {}
                                Err(Error::UnsupportedSchema(v)) => {
                                    return SessionEnd::Fatal(format!(
                                        "class policy uses schema v{v}, which this app version cannot read; update FOCUS OS"
                                    ));
                                }
                                Err(e) => {
                                    tracing::warn!("rejected policy from host: {e}");
                                    return SessionEnd::Fatal(format!(
                                        "rejected an invalid policy from the host: {e}"
                                    ));
                                }
                            },
                            Ok(ServerMsg::Revoked) => return SessionEnd::Removed,
                            Ok(ServerMsg::Ping) => {
                                let pong = serde_json::to_string(&ClientMsg::Pong).unwrap();
                                let _ = ws.send(Message::Text(pong.into())).await;
                            }
                            Err(_) => {} // unknown message types from newer hosts are ignored
                        }
                    }
                    Ok(Some(Ok(Message::Ping(p)))) => {
                        let _ = ws.send(Message::Pong(p)).await;
                    }
                    Ok(Some(Ok(_))) => {}
                }
            }
        }
        SessionEnd::Disconnected {
            was_live: false,
            reason: last_reason,
        }
    }
}

enum SessionEnd {
    Removed,
    Fatal(String),
    Disconnected { was_live: bool, reason: String },
}
