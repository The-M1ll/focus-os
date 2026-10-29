//! HTTP + WebSocket transport for the classroom host. Thin: every decision is made
//! by `HostService`.

use crate::error::{Error, Result};
use crate::host::{Authed, HostEvent, HostService};
use crate::protocol::*;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{Semaphore, watch};

pub const MAX_WS_CONNECTIONS: usize = 256;
pub const PORT_RANGE: std::ops::RangeInclusive<u16> = 47800..=47899;

#[derive(Clone)]
struct AppState {
    svc: Arc<HostService>,
    conns: Arc<Semaphore>,
    shutdown: watch::Receiver<bool>,
}

pub struct RunningHost {
    pub addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl RunningHost {
    /// Graceful stop: closes websockets, then the listener.
    pub async fn stop(self) {
        let _ = self.shutdown.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(3), self.task).await;
    }
}

/// Bind to a *specific* interface address (never 0.0.0.0). Prefers the app's port
/// range, falls back to an OS-assigned port.
pub async fn bind_listener(ip: IpAddr, preferred: Option<u16>) -> Result<TcpListener> {
    if let Some(p) = preferred {
        return TcpListener::bind(SocketAddr::new(ip, p))
            .await
            .map_err(|e| Error::Network(format!("cannot bind {ip}:{p}: {e}")));
    }
    for p in PORT_RANGE {
        if let Ok(l) = TcpListener::bind(SocketAddr::new(ip, p)).await {
            return Ok(l);
        }
    }
    TcpListener::bind(SocketAddr::new(ip, 0))
        .await
        .map_err(|e| Error::Network(format!("cannot bind {ip}: {e}")))
}

pub async fn serve(svc: Arc<HostService>, listener: TcpListener) -> Result<RunningHost> {
    let addr = listener.local_addr()?;
    let (stx, srx) = watch::channel(false);
    let state = AppState {
        svc,
        conns: Arc::new(Semaphore::new(MAX_WS_CONNECTIONS)),
        shutdown: srx.clone(),
    };
    let app = Router::new()
        .route("/v1/hello", get(hello))
        .route("/v1/join", post(join))
        .route("/v1/policy", get(policy))
        .route("/v1/ack", post(ack))
        .route("/v1/live", get(live))
        .route("/v1/admin/members", get(members))
        .route("/v1/admin/policy", post(publish))
        .route("/v1/admin/remove/{member_id}", post(remove))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state);
    let mut shutdown_rx = srx;
    let task = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.wait_for(|v| *v).await.map(|_| ());
        })
        .await;
    });
    Ok(RunningHost {
        addr,
        shutdown: stx,
        task,
    })
}

// ---- error mapping ---------------------------------------------------------

struct ApiError(Error);
impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        ApiError(e)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code) = match &self.0 {
            Error::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid"),
            Error::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden"),
            Error::Pairing(_) => (StatusCode::FORBIDDEN, "pairing"),
            Error::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            Error::RateLimited(_) => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            Error::Locked => (StatusCode::SERVICE_UNAVAILABLE, "locked"),
            Error::StaleRevision { .. } => (StatusCode::CONFLICT, "stale"),
            Error::UnsupportedSchema(_) => (StatusCode::UNPROCESSABLE_ENTITY, "unsupported_schema"),
            Error::Integrity(_) => (StatusCode::FORBIDDEN, "integrity"),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        };
        // Internal errors are logged, not echoed.
        let msg = if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!("internal error: {}", self.0);
            "internal error".to_string()
        } else {
            self.0.to_string()
        };
        (
            status,
            Json(ErrorBody {
                error: msg,
                code: code.into(),
            }),
        )
            .into_response()
    }
}

type ApiResult<T> = std::result::Result<T, ApiError>;

fn hdr<'a>(h: &'a HeaderMap, name: &str) -> Result<&'a str> {
    h.get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| Error::Forbidden(format!("missing header {name}")))
}

fn authenticate(
    svc: &HostService,
    h: &HeaderMap,
    method: &Method,
    uri: &Uri,
    body: &[u8],
) -> Result<Authed> {
    let ts: i64 = hdr(h, H_TS)?
        .parse()
        .map_err(|_| Error::invalid("bad timestamp"))?;
    let pq = uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    svc.authenticate(&crate::host::SignedRequest {
        class: hdr(h, H_CLASS)?,
        device: hdr(h, H_DEVICE)?,
        ts,
        nonce: hdr(h, H_NONCE)?,
        sig: hdr(h, H_SIG)?,
        method: method.as_str(),
        path: pq,
        body,
    })
}

fn parse<T: serde::de::DeserializeOwned>(b: &[u8]) -> Result<T> {
    serde_json::from_slice(b).map_err(|e| Error::invalid(format!("malformed JSON body: {e}")))
}

// ---- handlers --------------------------------------------------------------

async fn hello(State(s): State<AppState>) -> ApiResult<Json<Hello>> {
    Ok(Json(s.svc.hello()?))
}

async fn join(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> ApiResult<Json<JoinResponse>> {
    let req: JoinRequest = parse(&body)?;
    let svc = s.svc.clone();
    let remote = peer.ip().to_string();
    Ok(Json(
        tokio::task::spawn_blocking(move || svc.join(&req, &remote))
            .await
            .map_err(|e| Error::Network(e.to_string()))??,
    ))
}

async fn policy(
    State(s): State<AppState>,
    method: Method,
    uri: Uri,
    h: HeaderMap,
) -> ApiResult<Json<PolicyResponse>> {
    let a = authenticate(&s.svc, &h, &method, &uri, b"")?;
    Ok(Json(PolicyResponse {
        role: a.role,
        policy: s.svc.current_policy()?,
    }))
}

async fn ack(
    State(s): State<AppState>,
    method: Method,
    uri: Uri,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<StatusCode> {
    let a = authenticate(&s.svc, &h, &method, &uri, &body)?;
    let r: AckRequest = parse(&body)?;
    s.svc.record_ack(&a.device_id, r.revision)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn members(
    State(s): State<AppState>,
    method: Method,
    uri: Uri,
    h: HeaderMap,
) -> ApiResult<Json<Vec<crate::host::MemberInfo>>> {
    let a = authenticate(&s.svc, &h, &method, &uri, b"")?;
    Ok(Json(s.svc.list_members(&a.device_id)?))
}

async fn publish(
    State(s): State<AppState>,
    method: Method,
    uri: Uri,
    h: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<crate::policy::SignedPolicy>> {
    let a = authenticate(&s.svc, &h, &method, &uri, &body)?;
    let r: PublishRequest = parse(&body)?;
    Ok(Json(s.svc.publish_policy(&a.device_id, r.payload)?))
}

async fn remove(
    State(s): State<AppState>,
    method: Method,
    uri: Uri,
    h: HeaderMap,
    Path(member_id): Path<String>,
) -> ApiResult<StatusCode> {
    let a = authenticate(&s.svc, &h, &method, &uri, b"")?;
    s.svc.remove_member(&a.device_id, &member_id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn live(
    State(s): State<AppState>,
    method: Method,
    uri: Uri,
    h: HeaderMap,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    let a = authenticate(&s.svc, &h, &method, &uri, b"")?;
    let permit = s
        .conns
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::RateLimited(5))?;
    let svc = s.svc.clone();
    let shutdown = s.shutdown.clone();
    Ok(ws
        .max_message_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |sock| async move {
            live_loop(svc, a, sock, shutdown).await;
            drop(permit);
        }))
}

async fn send(sock: &mut WebSocket, m: &ServerMsg) -> bool {
    sock.send(Message::Text(serde_json::to_string(m).unwrap().into()))
        .await
        .is_ok()
}

async fn live_loop(
    svc: Arc<HostService>,
    auth: Authed,
    mut sock: WebSocket,
    mut shutdown: watch::Receiver<bool>,
) {
    svc.set_online(&auth.device_id, true);
    // Subscribe before reading the current policy so no publication can fall in the gap.
    let mut pol_rx = svc.subscribe_policy();
    let mut ev_rx = svc.subscribe_events();
    let mut ping = tokio::time::interval(Duration::from_secs(20));
    let mut last_rx = tokio::time::Instant::now();
    'outer: {
        if let Ok(Some(p)) = svc.current_policy()
            && !send(&mut sock, &ServerMsg::Policy { policy: p }).await
        {
            break 'outer;
        }
        loop {
            tokio::select! {
                _ = async { let _ = shutdown.wait_for(|v| *v).await; } => break,
                r = pol_rx.recv() => match r {
                    Ok(p) => { if !send(&mut sock, &ServerMsg::Policy { policy: p }).await { break; } }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Missed some pushes: resend the authoritative latest.
                        if let Ok(Some(p)) = svc.current_policy() && !send(&mut sock, &ServerMsg::Policy { policy: p }).await { break; }
                    }
                    Err(_) => break,
                },
                e = ev_rx.recv() => {
                    if let Ok(HostEvent::MemberRemoved { device_ids, .. }) = e
                        && device_ids.contains(&auth.device_id) {
                            let _ = send(&mut sock, &ServerMsg::Revoked).await;
                            break;
                        }
                }
                _ = ping.tick() => {
                    if last_rx.elapsed() > Duration::from_secs(70) { break; }
                    if !send(&mut sock, &ServerMsg::Ping).await { break; }
                }
                m = sock.recv() => match m {
                    Some(Ok(Message::Text(t))) => {
                        last_rx = tokio::time::Instant::now();
                        match serde_json::from_str::<ClientMsg>(t.as_str()) {
                            Ok(ClientMsg::Ack { revision }) => { let _ = svc.record_ack(&auth.device_id, revision); }
                            Ok(ClientMsg::Pong) => {}
                            Err(_) => break, // malformed frame: drop the connection
                        }
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => { last_rx = tokio::time::Instant::now(); }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => break, // binary frames are not part of the protocol
                },
            }
        }
    }
    let _ = sock.send(Message::Close(None)).await;
    svc.set_online(&auth.device_id, false);
}
