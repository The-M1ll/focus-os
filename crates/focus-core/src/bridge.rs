//! Loopback-only bridge for the FOCUS OS browser extension.
//!
//! * Binds 127.0.0.1 only. Never reachable from the LAN.
//! * Every data route needs `Authorization: Bearer <token>`; the token is shown to the user
//!   once so they can paste it into the extension. Web pages cannot read it.
//! * The extension reports *measured* foreground seconds; the app never invents usage.

use crate::error::{Error, Result};
use crate::personal::PersonalStore;
use crate::policy::TimeWindow;
use crate::ratelimit::RateLimiter;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio::sync::watch;

pub const BRIDGE_PORT: u16 = 47777;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct BridgeRule {
    pub platform: String,
    pub domains: Vec<String>,
    /// `None` = no budget (only blocked/allowed-hours apply).
    pub daily_limit_minutes: Option<u32>,
    pub blocked: bool,
    /// Minutes the student reported themselves today. Added to measured time so the extension and the
    /// app agree on what "used" means.
    #[serde(default)]
    pub self_reported_minutes: u32,
    /// Times the platform is available at all; empty = all day. The extension evaluates these
    /// itself in `time_zone`, so rules stay correct between pushes from the app.
    pub allowed_windows: Vec<TimeWindow>,
    /// Where this rule came from: "class" or "personal".
    pub origin: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct BridgeRules {
    pub revision: u64,
    pub day: String,
    pub time_zone: String,
    pub reset_hour: u8,
    pub rules: Vec<BridgeRule>,
}

#[derive(Deserialize)]
struct UsageReport {
    day: String,
    platform: String,
    seconds: u32,
}

#[derive(Clone)]
struct St {
    token: Arc<String>,
    rules: Arc<Mutex<BridgeRules>>,
    store: Arc<PersonalStore>,
    limiter: Arc<RateLimiter>,
    last_seen: Arc<AtomicI64>,
}

pub struct Bridge {
    pub addr: SocketAddr,
    rules: Arc<Mutex<BridgeRules>>,
    last_seen: Arc<AtomicI64>,
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl Bridge {
    pub async fn start(token: String, store: Arc<PersonalStore>, port: u16) -> Result<Self> {
        if token.len() < 32 {
            return Err(Error::invalid("bridge token too short"));
        }
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
            .await
            .map_err(|e| {
                Error::Network(format!(
                    "cannot bind extension bridge on 127.0.0.1:{port}: {e}"
                ))
            })?;
        let addr = listener.local_addr()?;
        let rules = Arc::new(Mutex::new(BridgeRules::default()));
        let last_seen = Arc::new(AtomicI64::new(0));
        let st = St {
            token: Arc::new(token),
            rules: rules.clone(),
            store,
            limiter: Arc::new(RateLimiter::default()),
            last_seen: last_seen.clone(),
        };
        let app = Router::new()
            .route("/v1/ping", get(ping))
            .route("/v1/rules", get(get_rules))
            .route("/v1/usage", post(post_usage))
            .layer(DefaultBodyLimit::max(4096))
            .with_state(st);
        let (stop, mut rx) = watch::channel(false);
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = rx.wait_for(|v| *v).await.map(|_| ());
                })
                .await;
        });
        Ok(Self {
            addr,
            rules,
            last_seen,
            stop,
            task,
        })
    }

    /// Unix ms of the last authenticated request from the extension (0 = never).
    pub fn extension_last_seen(&self) -> i64 {
        self.last_seen.load(Ordering::Relaxed)
    }

    pub fn set_rules(&self, r: BridgeRules) {
        *self.rules.lock().unwrap_or_else(|p| p.into_inner()) = r;
    }

    pub async fn stop(self) {
        let _ = self.stop.send(true);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), self.task).await;
    }
}

fn authed(st: &St, h: &HeaderMap) -> std::result::Result<(), StatusCode> {
    let ok = h
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|t| crate::crypto::ct_eq(t, &st.token));
    if ok {
        let now = crate::db::now_ms();
        st.last_seen.store(now, Ordering::Relaxed);
        if st.limiter.check("bridge", 600, 60_000, now).is_err() {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        Ok(())
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

async fn ping() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "app": "focus-os", "bridge": 1 }))
}

async fn get_rules(State(st): State<St>, h: HeaderMap) -> Response {
    if let Err(code) = authed(&st, &h) {
        return code.into_response();
    }
    Json(st.rules.lock().unwrap_or_else(|p| p.into_inner()).clone()).into_response()
}

async fn post_usage(State(st): State<St>, h: HeaderMap, body: axum::body::Bytes) -> Response {
    if let Err(code) = authed(&st, &h) {
        return code.into_response();
    }
    let Ok(rep) = serde_json::from_slice::<UsageReport>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    match st
        .store
        .add_measured_usage(&rep.day, &rep.platform, rep.seconds)
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}
