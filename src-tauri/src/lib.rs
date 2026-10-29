//! FOCUS OS native shell. Thin command layer over `focus-core`; no arbitrary shell or
//! filesystem access is exposed to the webview, and file dialogs are opened natively so
//! paths never originate in JavaScript.

mod apps;
mod classroom;
mod error;
mod personal;
pub mod state;

use state::AppState;
use tauri::Manager;

/// Registers every command. Shared by the real app and by tests that run on Tauri's mock runtime.
pub fn register_commands<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        personal::store_get_all,
        personal::store_write,
        personal::store_export_file,
        personal::store_import_file,
        personal::store_backup_now,
        personal::store_list_backups,
        personal::store_restore_backup,
        personal::measured_usage,
        personal::bridge_status,
        personal::bridge_set_rules,
        personal::notify,
        apps::apps_list,
        apps::apps_rescan,
        apps::apps_push,
        apps::apps_status,
        apps::apps_usage_range,
        classroom::class_overview,
        classroom::class_lan_addresses,
        classroom::class_create,
        classroom::class_host_start,
        classroom::class_host_stop,
        classroom::class_invite,
        classroom::class_members,
        classroom::class_remove_member,
        classroom::class_publish,
        classroom::class_audit,
        classroom::class_join,
        classroom::class_discover,
        classroom::class_sync_now,
        classroom::class_set_host_addr,
        classroom::class_leave,
        classroom::class_policy,
        classroom::class_export_recovery,
        classroom::class_transfer_begin,
        classroom::class_restore,
        classroom::class_rotate_passphrase,
    ])
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter("warn,focus_core=info,focus_os_lib=info")
        .init();
    register_commands(
        tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_notification::init())
            .setup(|app| {
                let dir = app
                    .path()
                    .app_data_dir()
                    .map_err(|e| format!("no app data dir: {e}"))?;
                std::fs::create_dir_all(&dir)?;
                let st =
                    AppState::open(dir).map_err(|e| format!("could not open local data: {e}"))?;
                let monitor = st.apps.clone();
                app.manage(st);
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(monitor.run(std::sync::Arc::new(move |n| apps::deliver(&handle, n))));
                Ok(())
            }),
    )
    .build(tauri::generate_context!())
    .expect("error while building FOCUS OS")
    .run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            // Stop hosting cleanly so members see a truthful disconnect.
            if let Some(st) = app.try_state::<AppState>() {
                tauri::async_runtime::block_on(st.shutdown());
            }
        }
    });
}
