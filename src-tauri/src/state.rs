use crate::error::{CmdError, CmdResult};
use focus_core::CLASSROOM_MIGRATIONS;
use focus_core::apps::{AppMonitor, SysProcesses};
use focus_core::bridge::{BRIDGE_PORT, Bridge};
use focus_core::crypto;
use focus_core::db::Db;
use focus_core::discovery::Advertiser;
use focus_core::host::HostService;
use focus_core::personal::PersonalStore;
use focus_core::server::RunningHost;
use focus_core::sync::ClassSync;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{Mutex, watch};

pub struct HostRuntime {
    pub svc: Arc<HostService>,
    pub running: Option<RunningHost>,
    pub advertiser: Option<Advertiser>,
    pub addr: Option<String>,
}

pub struct SyncRuntime {
    pub sync: Arc<ClassSync>,
    pub cancel: watch::Sender<bool>,
}

pub struct AppState {
    pub dir: PathBuf,
    pub personal: Arc<PersonalStore>,
    pub class_db: Arc<Db>,
    pub hosts: Mutex<HashMap<String, HostRuntime>>,
    pub syncs: Mutex<HashMap<String, SyncRuntime>>,
    pub bridge: Mutex<Option<Bridge>>,
    pub bridge_token: String,
    pub bridge_error: Mutex<Option<String>>,
    pub apps: Arc<AppMonitor>,
}

#[cfg(unix)]
fn restrict(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict(_: &std::path::Path) {}

impl AppState {
    pub fn open(dir: PathBuf) -> focus_core::Result<Self> {
        let personal_path = dir.join("personal.db");
        let class_path = dir.join("classroom.db");
        let personal = Arc::new(PersonalStore::open(&personal_path)?);
        let class_db = Arc::new(Db::open(&class_path, CLASSROOM_MIGRATIONS)?);
        restrict(&personal_path);
        restrict(&class_path);
        // Extension bridge token: generated once, stored with owner-only permissions.
        let token_path = dir.join("bridge.token");
        let token = match std::fs::read_to_string(&token_path) {
            Ok(t) if t.trim().len() >= 32 => t.trim().to_string(),
            _ => {
                let t = hex_token();
                std::fs::write(&token_path, &t)?;
                restrict(&token_path);
                t
            }
        };
        let apps = AppMonitor::new(personal.clone(), Box::new(SysProcesses::new()));
        Ok(Self {
            dir,
            personal,
            class_db,
            hosts: Mutex::new(HashMap::new()),
            syncs: Mutex::new(HashMap::new()),
            bridge: Mutex::new(None),
            bridge_token: token,
            bridge_error: Mutex::new(None),
            apps,
        })
    }

    pub async fn ensure_bridge(&self) {
        let mut b = self.bridge.lock().await;
        if b.is_some() {
            return;
        }
        match Bridge::start(
            self.bridge_token.clone(),
            self.personal.clone(),
            BRIDGE_PORT,
        )
        .await
        {
            Ok(br) => {
                *b = Some(br);
                *self.bridge_error.lock().await = None;
            }
            Err(e) => *self.bridge_error.lock().await = Some(e.to_string()),
        }
    }

    pub async fn shutdown(&self) {
        let mut hosts = self.hosts.lock().await;
        for (_, mut h) in hosts.drain() {
            h.advertiser.take();
            if let Some(r) = h.running.take() {
                r.stop().await;
            }
            h.svc.lock();
        }
        for (_, s) in self.syncs.lock().await.drain() {
            let _ = s.cancel.send(true);
        }
        if let Some(b) = self.bridge.lock().await.take() {
            b.stop().await;
        }
    }

    pub async fn admin_device(&self, class_id: &str) -> CmdResult<String> {
        let m = focus_core::client::load_membership(&self.class_db, class_id)?;
        if m.role != "admin" {
            return Err(CmdError::new(
                "forbidden",
                "this device is not the administrator of that class",
            ));
        }
        Ok(m.device_id)
    }

    pub async fn host_svc(&self, class_id: &str) -> CmdResult<Arc<HostService>> {
        self.hosts
            .lock()
            .await
            .get(class_id)
            .map(|h| h.svc.clone())
            .ok_or_else(|| {
                CmdError::new(
                    "locked",
                    "the class host is not running; unlock and start it first",
                )
            })
    }
}

fn hex_token() -> String {
    hex_of(&crypto::random_bytes::<32>())
}
fn hex_of(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
