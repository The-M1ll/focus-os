use crate::error::{CmdError, CmdResult};
use crate::state::AppState;
use focus_core::bridge::BridgeRules;
use focus_core::personal::{Doc, MeasuredUsage, PersonalStore, WriteOp};
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

#[tauri::command]
pub async fn store_get_all(st: State<'_, AppState>, collection: String) -> CmdResult<Vec<Doc>> {
    Ok(st.personal.get_all(&collection)?)
}

#[tauri::command]
pub async fn store_write(st: State<'_, AppState>, ops: Vec<WriteOp>) -> CmdResult<i64> {
    Ok(st.personal.write(&ops)?)
}

/// Opens a native "save" dialog; the chosen path never passes through JavaScript.
#[tauri::command]
pub async fn store_export_file<R: Runtime>(
    app: AppHandle<R>,
    st: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let json = st.personal.export_json()?;
    let Some(p) = app
        .dialog()
        .file()
        .set_file_name("focus-os-export.json")
        .add_filter("FOCUS OS export", &["json"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = p
        .into_path()
        .map_err(|e| CmdError::new("invalid", e.to_string()))?;
    std::fs::write(&path, json)
        .map_err(|e| CmdError::new("storage", format!("could not write export: {e}")))?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
pub async fn store_import_file<R: Runtime>(
    app: AppHandle<R>,
    st: State<'_, AppState>,
    replace: bool,
) -> CmdResult<Option<usize>> {
    let Some(p) = app
        .dialog()
        .file()
        .add_filter("FOCUS OS export", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = p
        .into_path()
        .map_err(|e| CmdError::new("invalid", e.to_string()))?;
    let meta = std::fs::metadata(&path).map_err(|e| CmdError::new("storage", e.to_string()))?;
    if meta.len() > 64 * 1024 * 1024 {
        return Err(CmdError::new(
            "invalid",
            "file is too large to be a FOCUS OS export",
        ));
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| CmdError::new("storage", format!("could not read file: {e}")))?;
    if replace {
        make_backup(&st, "pre-import")?; // never replace data without a safety copy
    }
    Ok(Some(st.personal.import_json(&text, replace)?))
}

#[derive(Serialize)]
pub struct BackupInfo {
    pub name: String,
    pub bytes: u64,
    pub modified_ms: i64,
}

fn backups_dir(st: &AppState) -> CmdResult<std::path::PathBuf> {
    let d = st.dir.join("backups");
    std::fs::create_dir_all(&d).map_err(|e| CmdError::new("storage", e.to_string()))?;
    Ok(d)
}

fn make_backup(st: &AppState, tag: &str) -> CmdResult<BackupInfo> {
    let dir = backups_dir(st)?;
    let now = focus_core::db::now_ms();
    let name = format!("focus-{tag}-{now}.db");
    let dest = dir.join(&name);
    st.personal.backup_to(&dest)?;
    // Keep the 20 newest backups.
    let mut all = list_backups(st)?;
    all.sort_by_key(|b| std::cmp::Reverse(b.modified_ms));
    for old in all.into_iter().skip(20) {
        let _ = std::fs::remove_file(dir.join(old.name));
    }
    let meta = std::fs::metadata(&dest).map_err(|e| CmdError::new("storage", e.to_string()))?;
    Ok(BackupInfo {
        name,
        bytes: meta.len(),
        modified_ms: now,
    })
}

fn list_backups(st: &AppState) -> CmdResult<Vec<BackupInfo>> {
    let dir = backups_dir(st)?;
    let mut out = vec![];
    for e in std::fs::read_dir(dir)
        .map_err(|e| CmdError::new("storage", e.to_string()))?
        .flatten()
    {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with("focus-") || !name.ends_with(".db") {
            continue;
        }
        if let Ok(m) = e.metadata() {
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            out.push(BackupInfo {
                name,
                bytes: m.len(),
                modified_ms: modified,
            });
        }
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.modified_ms));
    Ok(out)
}

#[tauri::command]
pub async fn store_backup_now(st: State<'_, AppState>) -> CmdResult<BackupInfo> {
    make_backup(&st, "manual")
}

#[tauri::command]
pub async fn store_list_backups(st: State<'_, AppState>) -> CmdResult<Vec<BackupInfo>> {
    list_backups(&st)
}

/// Restores by *name* from the app's own backup folder (no arbitrary paths), after taking a safety copy.
#[tauri::command]
pub async fn store_restore_backup(st: State<'_, AppState>, name: String) -> CmdResult<usize> {
    if name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || !name.starts_with("focus-")
        || !name.ends_with(".db")
    {
        return Err(CmdError::new("invalid", "invalid backup name"));
    }
    let path = backups_dir(&st)?.join(&name);
    PersonalStore::verify_backup(&path)?;
    make_backup(&st, "pre-restore")?;
    let src = PersonalStore::open(&path)?;
    let json = src.export_json()?;
    Ok(st.personal.import_json(&json, true)?)
}

#[tauri::command]
pub async fn measured_usage(
    st: State<'_, AppState>,
    from_day: String,
    to_day: String,
) -> CmdResult<Vec<MeasuredUsage>> {
    Ok(st.personal.measured_usage(&from_day, &to_day)?)
}

#[derive(Serialize)]
pub struct BridgeStatus {
    pub listening: bool,
    pub address: Option<String>,
    pub token: String,
    pub error: Option<String>,
    /// Unix ms of the last authenticated extension request; 0 = never.
    pub extension_last_seen: i64,
}

#[tauri::command]
pub async fn bridge_status(st: State<'_, AppState>) -> CmdResult<BridgeStatus> {
    st.ensure_bridge().await;
    let b = st.bridge.lock().await;
    Ok(BridgeStatus {
        listening: b.is_some(),
        address: b.as_ref().map(|b| b.addr.to_string()),
        token: st.bridge_token.clone(),
        error: st.bridge_error.lock().await.clone(),
        extension_last_seen: b.as_ref().map(|b| b.extension_last_seen()).unwrap_or(0),
    })
}

#[tauri::command]
pub async fn bridge_set_rules(st: State<'_, AppState>, rules: BridgeRules) -> CmdResult<()> {
    st.ensure_bridge().await;
    if let Some(b) = st.bridge.lock().await.as_ref() {
        b.set_rules(rules);
    }
    Ok(())
}

#[derive(Serialize)]
pub struct NotifyResult {
    pub delivered: bool,
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn notify<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
) -> CmdResult<NotifyResult> {
    if title.len() > 120 || body.len() > 400 {
        return Err(CmdError::new("invalid", "notification too long"));
    }
    match app.notification().builder().title(title).body(body).show() {
        Ok(()) => Ok(NotifyResult {
            delivered: true,
            reason: None,
        }),
        Err(e) => Ok(NotifyResult {
            delivered: false,
            reason: Some(e.to_string()),
        }),
    }
}
