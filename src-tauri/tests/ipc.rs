//! Drives the real Tauri commands through the real IPC path (Tauri's mock runtime, no window system).
//! Two independent app instances (own data dirs, own SQLite files, own keys) play teacher and student.

use serde_json::{Value, json};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::test::{INVOKE_KEY, MockRuntime, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{
    App, Manager, WebviewWindow,
    ipc::{CallbackFn, InvokeBody},
};

struct Instance {
    _app: App<MockRuntime>,
    win: WebviewWindow<MockRuntime>,
}

fn instance(dir: &Path) -> Instance {
    focus_core::crypto::use_fast_kdf_for_tests();
    let app = focus_os_lib::register_commands(mock_builder())
        .build(tauri::generate_context!())
        .unwrap();
    app.manage(focus_os_lib::state::AppState::open(dir.to_path_buf()).unwrap());
    let win = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    Instance { _app: app, win }
}

fn call(i: &Instance, cmd: &str, args: Value) -> Result<Value, Value> {
    // The webview's own origin: `tauri://localhost` on macOS/Linux, `http://tauri.localhost` on Windows.
    let origin = if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" };
    call_from(i, origin, cmd, args)
}

fn call_from(i: &Instance, origin: &str, cmd: &str, args: Value) -> Result<Value, Value> {
    let res = tauri::test::get_ipc_response(
        &i.win,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: origin.parse().unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    );
    res.map(|b| b.deserialize::<Value>().unwrap())
}

fn eventually(what: &str, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("timed out waiting for: {what}");
}

const PASS: &str = "correct horse battery";

#[test]
fn personal_store_roundtrip_backup_restore_and_input_validation() {
    let dir = tempfile::tempdir().unwrap();
    let a = instance(dir.path());
    call(
        &a,
        "store_write",
        json!({"ops":[{"op":"put","collection":"notes","id":"n1","json":"{\"t\":\"keep me\"}"}]}),
    )
    .unwrap();
    let docs = call(&a, "store_get_all", json!({"collection":"notes"})).unwrap();
    assert_eq!(docs.as_array().unwrap().len(), 1);

    // invalid inputs are refused with a typed error and change nothing
    let e = call(
        &a,
        "store_write",
        json!({"ops":[{"op":"put","collection":"notes","id":"n2","json":"not json"}]}),
    )
    .unwrap_err();
    assert_eq!(e["code"], "invalid");
    let e = call(&a, "store_get_all", json!({"collection":"../etc"})).unwrap_err();
    assert_eq!(e["code"], "invalid");
    assert_eq!(
        call(&a, "store_get_all", json!({"collection":"notes"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // backup, change, restore by NAME only
    let b = call(&a, "store_backup_now", json!({})).unwrap();
    let name = b["name"].as_str().unwrap().to_string();
    call(
        &a,
        "store_write",
        json!({"ops":[{"op":"put","collection":"notes","id":"n3","json":"{}"}]}),
    )
    .unwrap();
    for bad in [
        "../personal.db",
        "focus-x/../../y.db",
        "/etc/passwd",
        "evil.db",
    ] {
        let e = call(&a, "store_restore_backup", json!({"name": bad})).unwrap_err();
        assert_eq!(e["code"], "invalid", "{bad}");
    }
    call(&a, "store_restore_backup", json!({"name": name})).unwrap();
    let ids: Vec<String> = call(&a, "store_get_all", json!({"collection":"notes"}))
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, vec!["n1"]);
    let list = call(&a, "store_list_backups", json!({})).unwrap();
    assert!(
        list.as_array()
            .unwrap()
            .iter()
            .any(|b| b["name"].as_str().unwrap().contains("pre-restore")),
        "a safety copy is taken before restoring"
    );
}

#[test]
fn data_survives_app_restart() {
    let dir = tempfile::tempdir().unwrap();
    {
        let a = instance(dir.path());
        call(
            &a,
            "store_write",
            json!({"ops":[{"op":"put","collection":"tasks","id":"t1","json":"{\"title\":\"x\"}"}]}),
        )
        .unwrap();
    }
    let b = instance(dir.path());
    assert_eq!(
        call(&b, "store_get_all", json!({"collection":"tasks"}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn extension_bridge_status_exposes_token_and_loopback_only() {
    let dir = tempfile::tempdir().unwrap();
    let a = instance(dir.path());
    let s = call(&a, "bridge_status", json!({})).unwrap();
    assert!(s["token"].as_str().unwrap().len() >= 32);
    if s["listening"].as_bool().unwrap() {
        assert!(
            s["address"].as_str().unwrap().starts_with("127.0.0.1:"),
            "bridge must never listen beyond loopback"
        );
    } else {
        // Port 47777 can be busy on a dev machine; the error must then be reported, not hidden.
        assert!(s["error"].as_str().is_some());
    }
    // token is persisted and stable across restarts
    let tok = s["token"].as_str().unwrap().to_string();
    drop(a);
    let b = instance(dir.path());
    assert_eq!(
        call(&b, "bridge_status", json!({})).unwrap()["token"]
            .as_str()
            .unwrap(),
        tok
    );
}

#[test]
fn class_creation_rejects_weak_input() {
    let dir = tempfile::tempdir().unwrap();
    let t = instance(dir.path());
    let e = call(
        &t,
        "class_create",
        json!({"name":"A","adminName":"T","passphrase":"short","ip":null}),
    )
    .unwrap_err();
    assert_eq!(e["code"], "invalid");
    let e = call(
        &t,
        "class_create",
        json!({"name":"","adminName":"T","passphrase":PASS,"ip":null}),
    )
    .unwrap_err();
    assert_eq!(e["code"], "invalid");
    let e = call(
        &t,
        "class_create",
        json!({"name":"A","adminName":"T","passphrase":PASS,"ip":"203.0.113.9"}),
    )
    .unwrap_err();
    assert_eq!(
        e["code"], "invalid",
        "can only host on an address that belongs to this machine"
    );
    // nothing was created by the failed attempts
    assert!(
        call(&t, "class_overview", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn classroom_end_to_end_through_the_command_layer() {
    let tdir = tempfile::tempdir().unwrap();
    let sdir = tempfile::tempdir().unwrap();
    let teacher = instance(tdir.path());
    let student = instance(sdir.path());

    // Teacher creates a class and starts hosting (no internet involved).
    let created = call(
        &teacher,
        "class_create",
        json!({"name":"Physics 11A","adminName":"Ms. T","passphrase":PASS,"ip":null}),
    )
    .unwrap();
    let class_id = created["membership"]["class_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(created["membership"]["role"], "admin");
    assert_eq!(created["host"]["running"], true);
    let addr = created["host"]["address"].as_str().unwrap().to_string();

    // Invite -> student joins using only the code.
    let invite = call(
        &teacher,
        "class_invite",
        json!({"classId": class_id, "ttlMinutes": 10, "maxUses": 5}),
    )
    .unwrap();
    let uri = invite["uri"].as_str().unwrap().to_string();
    assert!(uri.starts_with("focusos://join/"));
    let joined = call(
        &student,
        "class_join",
        json!({"code": uri, "displayName": "Aziza", "overrideAddr": null}),
    )
    .unwrap();
    assert_eq!(joined["role"], "member");
    assert_eq!(joined["class_id"], class_id.as_str());

    // A student cannot use admin commands.
    let e = call(&student, "class_publish", json!({"classId": class_id, "payload": {"limits":[],"study_goals":[],"allow_personal_limits":true,"progress_sharing":"none"}})).unwrap_err();
    assert_eq!(e["code"], "forbidden");
    let e = call(
        &student,
        "class_invite",
        json!({"classId": class_id, "ttlMinutes": 5, "maxUses": 1}),
    )
    .unwrap_err();
    assert_eq!(e["code"], "forbidden");

    // Teacher publishes; the student's device receives and stores it (live websocket).
    let payload = json!({"limits":[{"platform":"tiktok","blocked":false,"daily_minutes":20,"allowed_windows":[]}],"study_goals":[{"id":"g1","title":"Read 30 pages","target_minutes_per_week":180}],"allow_personal_limits":false,"progress_sharing":"none"});
    let rev = call(
        &teacher,
        "class_publish",
        json!({"classId": class_id, "payload": payload}),
    )
    .unwrap();
    assert_eq!(rev, 1);
    eventually("student receives revision 1", || {
        call(&student, "class_policy", json!({"classId": class_id}))
            .map(|p| p["envelope"]["revision"] == 1)
            .unwrap_or(false)
    });
    let p = call(&student, "class_policy", json!({"classId": class_id})).unwrap();
    assert_eq!(p["envelope"]["payload"]["limits"][0]["daily_minutes"], 20);
    assert_eq!(p["envelope"]["payload"]["allow_personal_limits"], false);

    // The teacher sees the student's real acknowledgement.
    eventually("ack visible to admin", || {
        let m = call(&teacher, "class_members", json!({"classId": class_id})).unwrap();
        m.as_array().unwrap().iter().any(|m| {
            m["role"] == "member"
                && m["devices"][0]["acked_revision"] == 1
                && m["devices"][0]["online"] == true
        })
    });

    // Student sync status is Live while the host runs...
    eventually("student status live", || {
        call(&student, "class_overview", json!({})).unwrap()[0]["sync"]["state"] == "live"
    });

    // ...and truthfully becomes offline when the host stops, while the policy stays stored.
    call(&teacher, "class_host_stop", json!({"classId": class_id})).unwrap();
    eventually("student sees host go away", || {
        let st = call(&student, "class_overview", json!({})).unwrap();
        let s = &st[0]["sync"]["state"];
        s == "offline" || s == "connecting"
    });
    assert_eq!(
        call(&student, "class_policy", json!({"classId": class_id})).unwrap()["envelope"]["revision"],
        1
    );
    let _ = addr;

    // Restarting the host needs the passphrase; a wrong one is refused.
    let e = call(
        &teacher,
        "class_host_start",
        json!({"classId": class_id, "passphrase": "wrong passphrase!", "ip": null}),
    )
    .unwrap_err();
    assert_eq!(e["code"], "forbidden");
    call(
        &teacher,
        "class_host_start",
        json!({"classId": class_id, "passphrase": PASS, "ip": null}),
    )
    .unwrap();
    // A second revision reaches the reconnecting student.
    call(&teacher, "class_publish", json!({"classId": class_id, "payload": {"limits":[],"study_goals":[],"allow_personal_limits":true,"progress_sharing":"none"}})).unwrap();
    // (the host may come back on a new port; the student keeps its old address, so it needs the new one — the documented manual step)
    let new_addr = call(&teacher, "class_overview", json!({})).unwrap()[0]["host"]["address"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &student,
        "class_set_host_addr",
        json!({"classId": class_id, "addr": new_addr}),
    )
    .unwrap();
    eventually("student catches up to revision 2", || {
        call(&student, "class_policy", json!({"classId": class_id}))
            .map(|p| p["envelope"]["revision"] == 2)
            .unwrap_or(false)
    });

    // Removal cuts the student off and tells them.
    let members = call(&teacher, "class_members", json!({"classId": class_id})).unwrap();
    let sid = members
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "member")
        .unwrap()["member_id"]
        .as_str()
        .unwrap()
        .to_string();
    call(
        &teacher,
        "class_remove_member",
        json!({"classId": class_id, "memberId": sid}),
    )
    .unwrap();
    eventually("student learns it was removed", || {
        call(&student, "class_overview", json!({})).unwrap()[0]["sync"]["state"] == "removed"
    });

    // Audit log shows what happened, in order, hash-chained.
    let audit = call(&teacher, "class_audit", json!({"classId": class_id})).unwrap();
    let actions: Vec<&str> = audit
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["action"].as_str().unwrap())
        .collect();
    for want in [
        "class_created",
        "pairing_created",
        "member_joined",
        "policy_published",
        "member_removed",
        "unlock_failed",
    ] {
        assert!(
            actions.contains(&want),
            "missing audit action {want}: {actions:?}"
        );
    }
}

#[test]
fn invalid_join_codes_are_refused_with_clear_errors() {
    let dir = tempfile::tempdir().unwrap();
    let s = instance(dir.path());
    for bad in ["", "hello", "focusos://join/!!!", "focusos://join/e30"] {
        let e = call(
            &s,
            "class_join",
            json!({"code": bad, "displayName": "X", "overrideAddr": null}),
        )
        .unwrap_err();
        assert_eq!(e["code"], "invalid", "{bad:?}");
    }
}

#[test]
fn remote_web_content_cannot_reach_any_command() {
    // If a page from the internet ever ended up in the webview, it must not be able to call our commands.
    let dir = tempfile::tempdir().unwrap();
    let a = instance(dir.path());
    for cmd in [
        "store_get_all",
        "store_write",
        "class_overview",
        "class_create",
        "bridge_status",
        "store_export_file",
        "apps_list",
        "apps_push",
        "apps_status",
        "apps_usage_range",
    ] {
        let r = call_from(
            &a,
            "https://evil.example/",
            cmd,
            json!({"collection":"notes","ops":[]}),
        );
        assert!(r.is_err(), "{cmd} must be refused for a remote origin");
        let msg = r.unwrap_err().to_string();
        assert!(msg.contains("not allowed"), "{cmd}: {msg}");
    }
    // while the same call from the app's own origin works
    assert!(call(&a, "store_get_all", json!({"collection":"notes"})).is_ok());
}

#[test]
fn app_commands_validate_input_and_report_honestly() {
    let dir = tempfile::tempdir().unwrap();
    let a = instance(dir.path());
    let s = call(&a, "apps_status", json!({})).unwrap();
    assert_eq!(s["supported"], true);
    assert_eq!(s["usage"], json!([]));

    let rule = |slug: &str| json!({"slug": slug, "label": "x", "blocked_now": false, "why": "", "budget_secs": 600, "extra_used_secs": 0, "allowed_until_ms": null});
    // Rejected: bad day, bad app id.
    assert!(call(&a, "apps_push", json!({"policy": {"day": "today", "mode": "close", "rules": []}})).is_err());
    assert!(call(&a, "apps_push", json!({"policy": {"day": "2026-01-05", "mode": "close", "rules": [rule("Not Valid")]}})).is_err());
    // Accepted: a normal rule, and protected programs are reported as ignored instead of being enforced.
    call(&a, "apps_push", json!({"policy": {"day": "2026-01-05", "mode": "close", "rules": [rule("roblox"), rule("explorer")]}})).unwrap();
    let s = call(&a, "apps_status", json!({})).unwrap();
    assert_eq!(s["day"], "2026-01-05");
    assert_eq!(s["mode"], "close");
    assert_eq!(s["ignored"], json!(["explorer"]));

    // The list is an array and never offers a protected program.
    let list = call(&a, "apps_list", json!({})).unwrap();
    let names: Vec<String> = list.as_array().unwrap().iter().map(|e| e["slug"].as_str().unwrap().to_string()).collect();
    assert!(!names.iter().any(|n| n == "explorer" || n == "systemd" || n == "focus-os"), "{names:?}");
    // Usage range reads from storage.
    let u = call(&a, "apps_usage_range", json!({"fromDay": "2026-01-01", "toDay": "2026-01-31"})).unwrap();
    assert_eq!(u, json!([]));
    assert!(call(&a, "apps_usage_range", json!({"fromDay": "x", "toDay": "y"})).is_ok(), "an empty range is not an error");
}
