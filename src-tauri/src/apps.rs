//! Commands for the Apps section: list apps, push the effective rules, read usage.
//! Enforcement itself runs in `focus_core::apps::AppMonitor` on a background task.

use crate::error::CmdResult;
use crate::state::AppState;
use focus_core::apps::{AppEntry, AppsPolicy, AppsStatus, Notice};
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_notification::NotificationExt;

pub const NOTICE_EVENT: &str = "focus://apps-notice";

/// Shows an operating-system notification and tells the open window, so the student sees the warning
/// whether or not FOCUS OS is in front.
pub fn deliver<R: Runtime>(app: &AppHandle<R>, n: Notice) {
    let (title, body) = match &n {
        Notice::Closing { label, seconds_left, why, .. } => (format!("{label} will close in {seconds_left} s"), why.clone()),
        Notice::LowTime { label, seconds_left, .. } => (format!("{label}: about {} min left", (*seconds_left).div_ceil(60)), "Save your game or work now.".to_string()),
        Notice::Closed { label, why, .. } => (format!("{label} was closed"), why.clone()),
        Notice::Over { label, why, .. } => (format!("{label}: time is up"), why.clone()),
    };
    let _ = app.notification().builder().title(title).body(body).show();
    let _ = app.emit(NOTICE_EVENT, n);
}

#[tauri::command]
pub async fn apps_list(st: State<'_, AppState>) -> CmdResult<Vec<AppEntry>> {
    let m = st.apps.clone();
    tauri::async_runtime::spawn_blocking(move || m.list()).await.map_err(|e| crate::error::CmdError::new("internal", e.to_string()))
}

#[tauri::command]
pub async fn apps_rescan(st: State<'_, AppState>) -> CmdResult<()> {
    st.apps.rescan_installed();
    Ok(())
}

#[tauri::command]
pub async fn apps_push(st: State<'_, AppState>, policy: AppsPolicy) -> CmdResult<()> {
    Ok(st.apps.push(policy)?)
}

#[tauri::command]
pub async fn apps_status(st: State<'_, AppState>) -> CmdResult<AppsStatus> {
    Ok(st.apps.status())
}

#[tauri::command]
pub async fn apps_usage_range(st: State<'_, AppState>, from_day: String, to_day: String) -> CmdResult<Vec<(String, String, u64)>> {
    Ok(st.personal.app_usage_range(&from_day, &to_day)?)
}
