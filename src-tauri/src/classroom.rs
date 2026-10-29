use crate::error::{CmdError, CmdResult};
use crate::state::{AppState, HostRuntime, SyncRuntime};
use focus_core::client::{self, Membership};
use focus_core::discovery::{self, Advertiser, DiscoveredHost};
use focus_core::host::{
    AuditEntry, HostService, HostStatus, MemberInfo, RestoreMode, system_clock,
};
use focus_core::netinfo::{self, LanAddr};
use focus_core::policy::{PolicyEnvelope, PolicyPayload};
use focus_core::protocol::JoinPayload;
use focus_core::server;
use focus_core::sync::{self, ClassSync, SyncStatus};
use serde::Serialize;
use std::net::IpAddr;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::watch;

#[derive(Serialize, Clone)]
pub struct HostInfo {
    pub running: bool,
    pub unlocked: bool,
    pub address: Option<String>,
    pub status: Option<HostStatus>,
}

#[derive(Serialize, Clone)]
pub struct ClassOverview {
    pub membership: Membership,
    pub host: Option<HostInfo>,
    pub sync: Option<SyncStatus>,
}

async fn host_info(st: &AppState, class_id: &str) -> Option<HostInfo> {
    let hosts = st.hosts.lock().await;
    match hosts.get(class_id) {
        Some(h) => Some(HostInfo {
            running: h.running.is_some(),
            unlocked: h.svc.is_unlocked(),
            address: h.addr.clone(),
            status: h.svc.status().ok(),
        }),
        None => Some(HostInfo {
            running: false,
            unlocked: false,
            address: None,
            status: None,
        }),
    }
}

#[tauri::command]
pub async fn class_overview(st: State<'_, AppState>) -> CmdResult<Vec<ClassOverview>> {
    let ms = client::list_memberships(&st.class_db)?;
    let mut out = vec![];
    for m in ms {
        let host = if m.role == "admin" {
            host_info(&st, &m.class_id).await
        } else {
            None
        };
        let sync = st
            .syncs
            .lock()
            .await
            .get(&m.class_id)
            .map(|s| s.sync.status());
        out.push(ClassOverview {
            membership: m,
            host,
            sync,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn class_lan_addresses() -> CmdResult<Vec<LanAddr>> {
    Ok(netinfo::lan_addresses())
}

fn pick_ip(requested: Option<String>) -> CmdResult<IpAddr> {
    let addrs = netinfo::lan_addresses();
    match requested {
        Some(r) => {
            if !addrs.iter().any(|a| a.ip == r) {
                return Err(CmdError::new("invalid", "that address does not belong to a local network interface"));
            }
            r.parse().map_err(|_| CmdError::new("invalid", "bad address"))
        }
        None => addrs
            .first()
            .ok_or_else(|| CmdError::new("network", "no local network connection found. Connect to Wi-Fi or Ethernet to host a class."))?
            .ip
            .parse()
            .map_err(|_| CmdError::new("network", "bad local address")),
    }
}

/// Start the HTTP/WS service on one chosen interface and advertise via mDNS (best effort).
async fn start_hosting<R: Runtime>(
    app: &AppHandle<R>,
    st: &AppState,
    class_id: &str,
    passphrase: String,
    ip: Option<String>,
) -> CmdResult<HostInfo> {
    let ip = pick_ip(ip)?;
    {
        let hosts = st.hosts.lock().await;
        if hosts.get(class_id).is_some_and(|h| h.running.is_some()) {
            return Err(CmdError::new(
                "invalid",
                "this class is already being hosted",
            ));
        }
    }
    let svc = HostService::open(st.class_db.clone(), class_id, system_clock())?;
    let s2 = svc.clone();
    tokio::task::spawn_blocking(move || s2.unlock(&passphrase))
        .await
        .map_err(|e| CmdError::new("storage", e.to_string()))??;
    let listener = server::bind_listener(ip, None).await?;
    let running = server::serve(svc.clone(), listener).await?;
    let addr = running.addr.to_string();
    client::set_host_addrs(&st.class_db, class_id, std::slice::from_ref(&addr))?;
    // mDNS is optional: failure only means discovery is unavailable, manual join still works.
    let advertiser = Advertiser::start(class_id, ip, running.addr.port()).ok();

    // Forward host events to the UI.
    let mut rx = svc.subscribe_events();
    let app2 = app.clone();
    let cid = class_id.to_string();
    tauri::async_runtime::spawn(async move {
        while let Ok(ev) = rx.recv().await {
            let _ = app2.emit(
                "class-host",
                serde_json::json!({ "class_id": cid, "event": format!("{ev:?}") }),
            );
        }
    });

    st.hosts.lock().await.insert(
        class_id.to_string(),
        HostRuntime {
            svc: svc.clone(),
            running: Some(running),
            advertiser,
            addr: Some(addr.clone()),
        },
    );
    // The admin device also follows its own host like any member (live policy + honest status).
    start_sync_runtime(app, st, class_id).await;
    Ok(HostInfo {
        running: true,
        unlocked: true,
        address: Some(addr),
        status: svc.status().ok(),
    })
}

async fn start_sync_runtime<R: Runtime>(app: &AppHandle<R>, st: &AppState, class_id: &str) {
    let mut syncs = st.syncs.lock().await;
    if let Some(old) = syncs.remove(class_id) {
        let _ = old.cancel.send(true);
    }
    let Ok(cs) = ClassSync::new(st.class_db.clone(), class_id) else {
        return;
    };
    let (tx, rx) = watch::channel(false);
    tauri::async_runtime::spawn(cs.clone().run(rx));
    let mut srx = cs.watch_status();
    let app2 = app.clone();
    let cid = class_id.to_string();
    tauri::async_runtime::spawn(async move {
        while srx.changed().await.is_ok() {
            let s = srx.borrow().clone();
            let _ = app2.emit(
                "class-sync",
                serde_json::json!({ "class_id": cid, "status": s }),
            );
        }
    });
    syncs.insert(
        class_id.to_string(),
        SyncRuntime {
            sync: cs,
            cancel: tx,
        },
    );
}

#[tauri::command]
pub async fn class_create<R: Runtime>(
    app: AppHandle<R>,
    st: State<'_, AppState>,
    name: String,
    admin_name: String,
    passphrase: String,
    ip: Option<String>,
) -> CmdResult<ClassOverview> {
    // Validate the network choice first so a bad interface never leaves an orphan class behind.
    pick_ip(ip.clone())?;
    let (db, n, an, pw) = (st.class_db.clone(), name, admin_name, passphrase.clone());
    let created = tokio::task::spawn_blocking(move || {
        HostService::create_class(&db, &n, &an, &pw, &system_clock())
    })
    .await
    .map_err(|e| CmdError::new("storage", e.to_string()))??;
    let host = start_hosting(&app, &st, &created.class_id, passphrase, ip).await;
    let m = client::load_membership(&st.class_db, &created.class_id)?;
    match host {
        Ok(h) => Ok(ClassOverview {
            membership: m,
            host: Some(h),
            sync: None,
        }),
        // The class exists even if the socket could not be opened; say so with a distinct code
        // so the UI does not invite a retry that would create a second class.
        Err(e) => Err(CmdError::new(
            "created_not_hosting",
            format!(
                "The class was created, but hosting could not start: {}",
                e.message
            ),
        )),
    }
}

#[tauri::command]
pub async fn class_host_start<R: Runtime>(
    app: AppHandle<R>,
    st: State<'_, AppState>,
    class_id: String,
    passphrase: String,
    ip: Option<String>,
) -> CmdResult<HostInfo> {
    start_hosting(&app, &st, &class_id, passphrase, ip).await
}

#[tauri::command]
pub async fn class_host_stop(st: State<'_, AppState>, class_id: String) -> CmdResult<()> {
    if let Some(mut h) = st.hosts.lock().await.remove(&class_id) {
        h.advertiser.take();
        if let Some(r) = h.running.take() {
            r.stop().await;
        }
        h.svc.lock();
    }
    if let Some(s) = st.syncs.lock().await.remove(&class_id) {
        let _ = s.cancel.send(true);
    }
    Ok(())
}

#[derive(Serialize)]
pub struct Invite {
    pub uri: String,
    pub expires_at: i64,
    pub max_uses: u32,
    pub addrs: Vec<String>,
}

#[tauri::command]
pub async fn class_invite(
    st: State<'_, AppState>,
    class_id: String,
    ttl_minutes: u32,
    max_uses: u32,
) -> CmdResult<Invite> {
    let dev = st.admin_device(&class_id).await?;
    let svc = st.host_svc(&class_id).await?;
    let addr = st
        .hosts
        .lock()
        .await
        .get(&class_id)
        .and_then(|h| h.addr.clone())
        .ok_or_else(|| CmdError::new("locked", "host is not running"))?;
    let inv = svc.create_pairing(&dev, ttl_minutes as i64 * 60_000, max_uses)?;
    let jp = svc.join_payload(&inv, vec![addr.clone()])?;
    Ok(Invite {
        uri: jp.to_uri(),
        expires_at: inv.expires_at,
        max_uses,
        addrs: vec![addr],
    })
}

#[tauri::command]
pub async fn class_members(
    st: State<'_, AppState>,
    class_id: String,
) -> CmdResult<Vec<MemberInfo>> {
    let dev = st.admin_device(&class_id).await?;
    Ok(st.host_svc(&class_id).await?.list_members(&dev)?)
}

#[tauri::command]
pub async fn class_remove_member(
    st: State<'_, AppState>,
    class_id: String,
    member_id: String,
) -> CmdResult<()> {
    let dev = st.admin_device(&class_id).await?;
    Ok(st
        .host_svc(&class_id)
        .await?
        .remove_member(&dev, &member_id)?)
}

#[tauri::command]
pub async fn class_publish(
    st: State<'_, AppState>,
    class_id: String,
    payload: PolicyPayload,
) -> CmdResult<u64> {
    let dev = st.admin_device(&class_id).await?;
    let sp = st
        .host_svc(&class_id)
        .await?
        .publish_policy(&dev, payload)?;
    let env: PolicyEnvelope =
        serde_json::from_str(&sp.envelope).map_err(|e| CmdError::new("invalid", e.to_string()))?;
    Ok(env.revision)
}

#[tauri::command]
pub async fn class_audit(st: State<'_, AppState>, class_id: String) -> CmdResult<Vec<AuditEntry>> {
    let dev = st.admin_device(&class_id).await?;
    Ok(st.host_svc(&class_id).await?.audit_log(&dev, 100)?)
}

#[tauri::command]
pub async fn class_join<R: Runtime>(
    app: AppHandle<R>,
    st: State<'_, AppState>,
    code: String,
    display_name: String,
    override_addr: Option<String>,
) -> CmdResult<Membership> {
    let mut jp = JoinPayload::from_uri(&code)?;
    if let Some(a) = override_addr.filter(|a| !a.trim().is_empty()) {
        jp.addrs.insert(0, a.trim().to_string());
    }
    let m = sync::join_class(&st.class_db, &jp, &display_name).await?;
    start_sync_runtime(&app, &st, &m.class_id).await;
    Ok(m)
}

#[tauri::command]
pub async fn class_discover(timeout_ms: u64) -> CmdResult<Vec<DiscoveredHost>> {
    let t = Duration::from_millis(timeout_ms.clamp(500, 8000));
    tokio::task::spawn_blocking(move || discovery::browse(t, None))
        .await
        .map_err(|e| CmdError::new("network", e.to_string()))?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn class_sync_now<R: Runtime>(
    app: AppHandle<R>,
    st: State<'_, AppState>,
    class_id: String,
) -> CmdResult<String> {
    if !st.syncs.lock().await.contains_key(&class_id) {
        start_sync_runtime(&app, &st, &class_id).await;
    }
    let cs = st
        .syncs
        .lock()
        .await
        .get(&class_id)
        .map(|s| s.sync.clone())
        .ok_or_else(|| CmdError::new("not_found", "no such class"))?;
    let out = cs.fetch_once().await?;
    Ok(format!("{out:?}"))
}

#[tauri::command]
pub async fn class_set_host_addr(
    st: State<'_, AppState>,
    class_id: String,
    addr: String,
) -> CmdResult<()> {
    let a = addr.trim().to_string();
    if a.parse::<std::net::SocketAddr>().is_err() {
        return Err(CmdError::new(
            "invalid",
            "enter the address as ip:port, for example 192.168.1.20:47800",
        ));
    }
    Ok(client::set_host_addrs(&st.class_db, &class_id, &[a])?)
}

#[tauri::command]
pub async fn class_leave(st: State<'_, AppState>, class_id: String) -> CmdResult<()> {
    if let Some(s) = st.syncs.lock().await.remove(&class_id) {
        let _ = s.cancel.send(true);
    }
    let m = client::load_membership(&st.class_db, &class_id)?;
    if m.role == "admin" {
        return Err(CmdError::new(
            "forbidden",
            "the administrator cannot leave; transfer administration first",
        ));
    }
    Ok(client::leave_class(&st.class_db, &class_id)?)
}

#[derive(Serialize)]
pub struct StoredPolicy {
    pub envelope: PolicyEnvelope,
    pub received_at: i64,
}

#[tauri::command]
pub async fn class_policy(
    st: State<'_, AppState>,
    class_id: String,
) -> CmdResult<Option<StoredPolicy>> {
    Ok(
        client::current_policy(&st.class_db, &class_id)?.map(|(envelope, received_at)| {
            StoredPolicy {
                envelope,
                received_at,
            }
        }),
    )
}

#[tauri::command]
pub async fn class_rotate_passphrase(
    st: State<'_, AppState>,
    class_id: String,
    old: String,
    new: String,
) -> CmdResult<()> {
    let svc = st.host_svc(&class_id).await?;
    tokio::task::spawn_blocking(move || svc.rotate_passphrase(&old, &new))
        .await
        .map_err(|e| CmdError::new("storage", e.to_string()))??;
    Ok(())
}

async fn save_text<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    text: String,
) -> CmdResult<Option<String>> {
    let Some(p) = app
        .dialog()
        .file()
        .set_file_name(name)
        .add_filter("FOCUS OS recovery bundle", &["fosrecovery"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = p
        .into_path()
        .map_err(|e| CmdError::new("invalid", e.to_string()))?;
    std::fs::write(&path, text)
        .map_err(|e| CmdError::new("storage", format!("could not write file: {e}")))?;
    Ok(Some(path.display().to_string()))
}

/// Export a recovery bundle without changing authority.
#[tauri::command]
pub async fn class_export_recovery<R: Runtime>(
    app: AppHandle<R>,
    st: State<'_, AppState>,
    class_id: String,
    bundle_passphrase: String,
) -> CmdResult<Option<String>> {
    let dev = st.admin_device(&class_id).await?;
    let svc = st.host_svc(&class_id).await?;
    let bundle =
        tokio::task::spawn_blocking(move || svc.export_recovery_bundle(&dev, &bundle_passphrase))
            .await
            .map_err(|e| CmdError::new("storage", e.to_string()))??;
    save_text(&app, "class-recovery.fosrecovery", bundle).await
}

/// Hand administration to another device. The file is written BEFORE authority is retired.
#[tauri::command]
pub async fn class_transfer_begin<R: Runtime>(
    app: AppHandle<R>,
    st: State<'_, AppState>,
    class_id: String,
    bundle_passphrase: String,
) -> CmdResult<Option<String>> {
    let dev = st.admin_device(&class_id).await?;
    let svc = st.host_svc(&class_id).await?;
    // Export first (non-destructive) so the user can pick a location; only then retire authority.
    let (s2, d2, p2) = (svc.clone(), dev.clone(), bundle_passphrase.clone());
    let bundle = tokio::task::spawn_blocking(move || s2.export_recovery_bundle(&d2, &p2))
        .await
        .map_err(|e| CmdError::new("storage", e.to_string()))??;
    let Some(path) = save_text(&app, "class-transfer.fosrecovery", bundle).await? else {
        return Ok(None);
    };
    // Verify the file we wrote is readable before giving up authority.
    let written =
        std::fs::read_to_string(&path).map_err(|e| CmdError::new("storage", e.to_string()))?;
    if written.len() < 100 {
        return Err(CmdError::new(
            "storage",
            "the transfer file could not be verified; authority was NOT transferred",
        ));
    }
    let s3 = svc.clone();
    tokio::task::spawn_blocking(move || s3.begin_transfer(&dev, &bundle_passphrase))
        .await
        .map_err(|e| CmdError::new("storage", e.to_string()))??;
    class_host_stop_inner(&st, &class_id).await;
    Ok(Some(path))
}

async fn class_host_stop_inner(st: &AppState, class_id: &str) {
    if let Some(mut h) = st.hosts.lock().await.remove(class_id) {
        h.advertiser.take();
        if let Some(r) = h.running.take() {
            r.stop().await;
        }
    }
    if let Some(s) = st.syncs.lock().await.remove(class_id) {
        let _ = s.cancel.send(true);
    }
}

#[tauri::command]
pub async fn class_restore<R: Runtime>(
    app: AppHandle<R>,
    st: State<'_, AppState>,
    bundle_passphrase: String,
    new_passphrase: String,
    admin_name: String,
    recovery: bool,
) -> CmdResult<Option<Membership>> {
    let Some(p) = app
        .dialog()
        .file()
        .add_filter("FOCUS OS recovery bundle", &["fosrecovery"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = p
        .into_path()
        .map_err(|e| CmdError::new("invalid", e.to_string()))?;
    let meta = std::fs::metadata(&path).map_err(|e| CmdError::new("storage", e.to_string()))?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err(CmdError::new(
            "invalid",
            "file is too large to be a recovery bundle",
        ));
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| CmdError::new("storage", e.to_string()))?;
    let db = st.class_db.clone();
    let mode = if recovery {
        RestoreMode::Recovery
    } else {
        RestoreMode::Transfer
    };
    let created = tokio::task::spawn_blocking(move || {
        HostService::restore_from_bundle(
            &db,
            &text,
            &bundle_passphrase,
            &new_passphrase,
            &admin_name,
            mode,
            &system_clock(),
        )
    })
    .await
    .map_err(|e| CmdError::new("storage", e.to_string()))??;
    Ok(Some(client::load_membership(
        &st.class_db,
        &created.class_id,
    )?))
}
