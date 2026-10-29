//! Multi-instance classroom tests over real TCP/WebSocket on loopback.
//! Each "device" has its own SQLite database and its own device key. This is NOT a
//! multi-machine test: router isolation, firewalls and mDNS are out of scope here.

use focus_core::client::{self, ApplyOutcome};
use focus_core::db::Db;
use focus_core::host::*;
use focus_core::policy::*;
use focus_core::protocol::*;
use focus_core::server::{self, RunningHost};
use focus_core::sync::{self, ClassSync, SyncState};
use focus_core::{CLASSROOM_MIGRATIONS, Error};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

const PASS: &str = "correct horse battery";

struct Admin {
    db: Arc<Db>,
    host: Arc<HostService>,
    running: Option<RunningHost>,
    class_id: String,
    device: String,
    addr: String,
}

async fn start_admin() -> Admin {
    focus_core::crypto::use_fast_kdf_for_tests();
    let db = Arc::new(Db::open_in_memory(CLASSROOM_MIGRATIONS).unwrap());
    let clock = system_clock();
    let c = HostService::create_class(&db, "Physics 11A", "Teacher", PASS, &clock).unwrap();
    let host = HostService::open(db.clone(), &c.class_id, clock).unwrap();
    host.unlock(PASS).unwrap();
    let l = server::bind_listener(IpAddr::V4(Ipv4Addr::LOCALHOST), Some(0))
        .await
        .unwrap();
    let running = server::serve(host.clone(), l).await.unwrap();
    let addr = running.addr.to_string();
    client::set_host_addrs(&db, &c.class_id, std::slice::from_ref(&addr)).unwrap();
    Admin {
        db,
        host,
        running: Some(running),
        class_id: c.class_id,
        device: c.admin_device_id,
        addr,
    }
}

fn payload(minutes: u32) -> PolicyPayload {
    PolicyPayload {
        limits: vec![LimitRule {
            platform: "tiktok".into(),
            blocked: false,
            daily_minutes: Some(minutes),
            allowed_windows: vec![],
        }],
        study_goals: vec![StudyGoal {
            id: "g1".into(),
            title: "Read 20 pages".into(),
            target_minutes_per_week: 120,
        }],
        allow_personal_limits: true,
        progress_sharing: ProgressSharing::None,
    }
}

async fn join_client(a: &Admin, name: &str) -> (Arc<Db>, JoinPayload) {
    let inv = a.host.create_pairing(&a.device, 60_000, 30).unwrap();
    let jp = a.host.join_payload(&inv, vec![a.addr.clone()]).unwrap();
    let db = Arc::new(Db::open_in_memory(CLASSROOM_MIGRATIONS).unwrap());
    sync::join_class(&db, &jp, name).await.unwrap();
    (db, jp)
}

async fn eventually<F: FnMut() -> bool>(what: &str, mut f: F) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for: {what}");
}

fn start_sync(
    db: &Arc<Db>,
    class_id: &str,
) -> (
    Arc<ClassSync>,
    watch::Sender<bool>,
    tokio::task::JoinHandle<()>,
) {
    let s = ClassSync::new(db.clone(), class_id).unwrap();
    let (tx, rx) = watch::channel(false);
    let h = tokio::spawn(s.clone().run(rx));
    (s, tx, h)
}

async fn signed_post(
    addr: &str,
    class: &str,
    key: &focus_core::crypto::KeyPair,
    path: &str,
    body: Vec<u8>,
) -> reqwest::Response {
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut rb = c.post(format!("http://{addr}{path}")).body(body.clone());
    for (k, v) in sync::signed_headers(class, key, "POST", path, &body) {
        rb = rb.header(k, v);
    }
    rb.send().await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn class_created_offline_joined_and_policy_reaches_two_clients() {
    let a = start_admin().await;
    let (db1, jp) = join_client(&a, "Aziza").await;
    let (db2, _) = join_client(&a, "Bek").await;
    assert_eq!(
        client::load_membership(&db1, &jp.class_id).unwrap().role,
        "member"
    );

    let (s1, c1, h1) = start_sync(&db1, &jp.class_id);
    let (s2, c2, h2) = start_sync(&db2, &jp.class_id);
    eventually("both live", || {
        s1.status().state == SyncState::Live && s2.status().state == SyncState::Live
    })
    .await;

    let sp = a.host.publish_policy(&a.device, payload(25)).unwrap();
    for (db, name) in [(&db1, "client1"), (&db2, "client2")] {
        let cid = jp.class_id.clone();
        eventually(name, || {
            client::load_membership(db, &cid).unwrap().last_revision == 1
        })
        .await;
        let (env, _) = client::current_policy(db, &cid).unwrap().unwrap();
        assert_eq!(env.payload.limits[0].daily_minutes, Some(25));
        assert_eq!(env.revision, 1);
    }
    // Host sees real acknowledgements from both devices.
    eventually("acks recorded", || {
        let m = a.host.list_members(&a.device).unwrap();
        m.iter()
            .filter(|m| m.role == "member")
            .all(|m| m.devices[0].acked_revision == 1 && m.devices[0].online)
    })
    .await;
    assert_eq!(
        sp.key_id,
        client::load_membership(&db1, &jp.class_id).unwrap().key_id
    );

    c1.send(true).unwrap();
    c2.send(true).unwrap();
    h1.await.unwrap();
    h2.await.unwrap();
    a.running.unwrap().stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unauthorized_clients_cannot_change_policy_or_list_members() {
    let a = start_admin().await;
    let (sdb, jp) = join_client(&a, "Student").await;
    let skey = client::device_key(&sdb, &jp.class_id).unwrap();
    let body = serde_json::to_vec(&PublishRequest {
        payload: payload(1),
    })
    .unwrap();

    // Authenticated member without admin role.
    let r = signed_post(
        &a.addr,
        &jp.class_id,
        &skey,
        "/v1/admin/policy",
        body.clone(),
    )
    .await;
    assert_eq!(r.status(), 403);
    assert!(a.host.current_policy().unwrap().is_none());

    // No authentication at all.
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    let r = c
        .post(format!("http://{}/v1/admin/policy", a.addr))
        .body(body.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);

    // Stranger key (never enrolled), correctly signed.
    let stranger = focus_core::crypto::KeyPair::generate();
    let r = signed_post(
        &a.addr,
        &jp.class_id,
        &stranger,
        "/v1/admin/policy",
        body.clone(),
    )
    .await;
    assert_eq!(r.status(), 403);

    // Valid signature but body swapped afterwards (tamper in flight).
    let mut rb = c.post(format!("http://{}/v1/admin/policy", a.addr)).body(
        serde_json::to_vec(&PublishRequest {
            payload: payload(2),
        })
        .unwrap(),
    );
    for (k, v) in sync::signed_headers(&jp.class_id, &skey, "POST", "/v1/admin/policy", &body) {
        rb = rb.header(k, v);
    }
    assert_eq!(rb.send().await.unwrap().status(), 403);

    // Members cannot list the roster.
    let mut rb = c.get(format!("http://{}/v1/admin/members", a.addr));
    for (k, v) in sync::signed_headers(&jp.class_id, &skey, "GET", "/v1/admin/members", b"") {
        rb = rb.header(k, v);
    }
    assert_eq!(rb.send().await.unwrap().status(), 403);

    // The real admin, over the network, can publish.
    let akey = client::device_key(&a.db, &a.class_id).unwrap();
    let r = signed_post(&a.addr, &a.class_id, &akey, "/v1/admin/policy", body).await;
    assert_eq!(r.status(), 200);
    assert_eq!(a.host.status().unwrap().current_revision, 1);
    a.running.unwrap().stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn replayed_signed_request_is_rejected() {
    let a = start_admin().await;
    let (sdb, jp) = join_client(&a, "S").await;
    let key = client::device_key(&sdb, &jp.class_id).unwrap();
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    let hdrs = sync::signed_headers(&jp.class_id, &key, "GET", "/v1/policy", b"");
    let send = || {
        let mut rb = c.get(format!("http://{}/v1/policy", a.addr));
        for (k, v) in &hdrs {
            rb = rb.header(*k, v.clone());
        }
        rb.send()
    };
    assert_eq!(send().await.unwrap().status(), 200);
    assert_eq!(
        send().await.unwrap().status(),
        403,
        "identical request must not be accepted twice"
    );
    a.running.unwrap().stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn join_failures_wrong_token_expired_unreachable() {
    let a = start_admin().await;
    let inv = a.host.create_pairing(&a.device, 60_000, 5).unwrap();
    let mut jp = a.host.join_payload(&inv, vec![a.addr.clone()]).unwrap();
    let db = Arc::new(Db::open_in_memory(CLASSROOM_MIGRATIONS).unwrap());

    let good = jp.token.clone();
    jp.token = focus_core::crypto::b64(&[1u8; 16]);
    assert!(matches!(
        sync::join_class(&db, &jp, "X").await,
        Err(Error::Forbidden(_))
    ));
    assert!(
        client::list_memberships(&db).unwrap().is_empty(),
        "nothing persisted on failed join"
    );
    jp.token = good;

    // Expired pairing.
    let short = a.host.create_pairing(&a.device, 1, 5).unwrap();
    let jp2 = a.host.join_payload(&short, vec![a.addr.clone()]).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(sync::join_class(&db, &jp2, "Late").await.is_err());

    // Host not reachable: message explains network isolation.
    let mut jp3 = jp.clone();
    jp3.addrs = vec!["127.0.0.1:1".into()];
    match sync::join_class(&db, &jp3, "Y").await {
        Err(Error::Network(m)) => assert!(m.contains("isolate"), "{m}"),
        other => panic!("expected network error, got {other:?}"),
    }
    // Honest join still works afterwards (the failed attempts did not burn a valid code).
    sync::join_class(&db, &jp, "Honest").await.unwrap();
    a.running.unwrap().stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn client_that_missed_updates_gets_latest_on_reconnect_and_survives_restart() {
    let a = start_admin().await;
    let (db, jp) = join_client(&a, "Offline Olga").await;
    let cid = jp.class_id.clone();

    let (s, cancel, h) = start_sync(&db, &cid);
    eventually("live", || s.status().state == SyncState::Live).await;
    a.host.publish_policy(&a.device, payload(30)).unwrap();
    eventually("rev1", || {
        client::load_membership(&db, &cid).unwrap().last_revision == 1
    })
    .await;
    cancel.send(true).unwrap();
    h.await.unwrap();

    // Client is "off". Admin publishes revisions 2 and 3.
    a.host.publish_policy(&a.device, payload(20)).unwrap();
    a.host.publish_policy(&a.device, payload(10)).unwrap();
    assert_eq!(client::load_membership(&db, &cid).unwrap().last_revision, 1);

    // "App restart": brand new ClassSync over the same database.
    let (s2, cancel2, h2) = start_sync(&db, &cid);
    assert_eq!(s2.status().last_revision, 1, "state survives restart");
    eventually("caught up", || {
        client::load_membership(&db, &cid).unwrap().last_revision == 3
    })
    .await;
    let (env, _) = client::current_policy(&db, &cid).unwrap().unwrap();
    assert_eq!(env.payload.limits[0].daily_minutes, Some(10));
    cancel2.send(true).unwrap();
    h2.await.unwrap();

    // HTTP "sync now" is idempotent.
    let s3 = ClassSync::new(db.clone(), &cid).unwrap();
    assert_eq!(s3.fetch_once().await.unwrap(), ApplyOutcome::Duplicate(3));
    a.running.unwrap().stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn host_restart_shows_offline_keeps_policy_then_reconnects() {
    let mut a = start_admin().await;
    let (db, jp) = join_client(&a, "Kim").await;
    let cid = jp.class_id.clone();
    let (s, cancel, h) = start_sync(&db, &cid);
    eventually("live", || s.status().state == SyncState::Live).await;
    a.host.publish_policy(&a.device, payload(30)).unwrap();
    eventually("rev1", || {
        client::load_membership(&db, &cid).unwrap().last_revision == 1
    })
    .await;

    // Host goes away.
    let port = a.running.as_ref().unwrap().addr.port();
    a.running.take().unwrap().stop().await;
    eventually("offline", || {
        matches!(
            s.status().state,
            SyncState::Offline { .. } | SyncState::Connecting
        )
    })
    .await;
    let st = s.status();
    assert!(
        st.last_sync_at.is_some(),
        "last successful sync time is kept"
    );
    assert_eq!(
        client::current_policy(&db, &cid)
            .unwrap()
            .unwrap()
            .0
            .revision,
        1,
        "policy persists while host is down"
    );

    // Host process restarts: new service instance over the same database, must unlock again.
    let host2 = HostService::open(a.db.clone(), &a.class_id, system_clock()).unwrap();
    assert!(!host2.is_unlocked());
    assert!(matches!(
        host2.publish_policy(&a.device, payload(5)),
        Err(Error::Locked)
    ));
    host2.unlock(PASS).unwrap();
    let l = server::bind_listener(IpAddr::V4(Ipv4Addr::LOCALHOST), Some(port))
        .await
        .unwrap();
    let running = server::serve(host2.clone(), l).await.unwrap();
    host2.publish_policy(&a.device, payload(5)).unwrap();
    eventually("reconnected and caught up", || {
        s.status().state == SyncState::Live
            && client::load_membership(&db, &cid).unwrap().last_revision == 2
    })
    .await;
    cancel.send(true).unwrap();
    h.await.unwrap();
    running.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn removed_member_is_cut_off_and_told() {
    let a = start_admin().await;
    let (db, jp) = join_client(&a, "Leaver").await;
    let cid = jp.class_id.clone();
    let (s, _cancel, h) = start_sync(&db, &cid);
    eventually("live", || s.status().state == SyncState::Live).await;
    let member_id = client::load_membership(&db, &cid).unwrap().member_id;
    a.host.remove_member(&a.device, &member_id).unwrap();
    eventually("removed state", || s.status().state == SyncState::Removed).await;
    h.await.unwrap();
    assert_eq!(
        client::load_membership(&db, &cid).unwrap().status,
        "removed"
    );
    // And a new run is refused by the host.
    let key = client::device_key(&db, &cid).unwrap();
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    let mut rb = c.get(format!("http://{}/v1/policy", a.addr));
    for (k, v) in sync::signed_headers(&cid, &key, "GET", "/v1/policy", b"") {
        rb = rb.header(k, v);
    }
    assert_eq!(rb.send().await.unwrap().status(), 403);
    a.running.unwrap().stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn malformed_and_oversized_input_is_rejected_without_state_change() {
    let a = start_admin().await;
    let (sdb, jp) = join_client(&a, "Fuzz").await;
    let key = client::device_key(&sdb, &jp.class_id).unwrap();
    let c = reqwest::Client::builder().no_proxy().build().unwrap();

    // Garbage join body.
    let r = c
        .post(format!("http://{}/v1/join", a.addr))
        .body("{not json")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    // Oversized body (limit 16 KiB).
    let r = c
        .post(format!("http://{}/v1/join", a.addr))
        .body(vec![b'a'; 200_000])
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 413);
    // Ack for a revision that does not exist.
    let r = signed_post(
        &a.addr,
        &jp.class_id,
        &key,
        "/v1/ack",
        serde_json::to_vec(&AckRequest { revision: 99 }).unwrap(),
    )
    .await;
    assert_eq!(r.status(), 400);
    // Admin publishing an invalid policy over the wire is refused and consumes no revision.
    let akey = client::device_key(&a.db, &a.class_id).unwrap();
    let bad = serde_json::json!({"payload": {"limits": [{"platform":"x","blocked":false,"daily_minutes":99999,"allowed_windows":[]}], "study_goals": [], "allow_personal_limits": true}});
    let r = signed_post(
        &a.addr,
        &a.class_id,
        &akey,
        "/v1/admin/policy",
        serde_json::to_vec(&bad).unwrap(),
    )
    .await;
    assert_eq!(r.status(), 400);
    let unknown_field = serde_json::json!({"payload": {"limits": [], "study_goals": [], "allow_personal_limits": true, "evil": 1}});
    let r = signed_post(
        &a.addr,
        &a.class_id,
        &akey,
        "/v1/admin/policy",
        serde_json::to_vec(&unknown_field).unwrap(),
    )
    .await;
    assert_eq!(r.status(), 400);
    assert_eq!(a.host.status().unwrap().current_revision, 0);

    // Garbage WebSocket frame drops only that connection.
    use futures_util::SinkExt;
    use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest};
    let mut req = format!("ws://{}/v1/live", a.addr)
        .into_client_request()
        .unwrap();
    for (k, v) in sync::signed_headers(&jp.class_id, &key, "GET", "/v1/live", b"") {
        req.headers_mut().insert(k, v.parse().unwrap());
    }
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws.send(Message::Text("definitely not json".into()))
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    // Server stays healthy.
    let r = c
        .get(format!("http://{}/v1/hello", a.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    a.running.unwrap().stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn client_ignores_policy_from_impostor_host() {
    // An attacker on the LAN runs their own host and tries to feed a policy to a joined client.
    let real = start_admin().await;
    let (db, jp) = join_client(&real, "Victim").await;
    let impostor = start_admin().await;
    let ikey = client::device_key(&impostor.db, &impostor.class_id).unwrap();
    let _ = ikey;
    // Impostor publishes a (validly signed by ITS key) policy under its own class id.
    let forged = impostor
        .host
        .publish_policy(&impostor.device, payload(1))
        .unwrap();
    let res = client::apply_policy(&db, &jp.class_id, &forged, 1);
    assert!(
        res.is_err(),
        "policy signed by a key other than the pinned class key must be rejected"
    );
    assert_eq!(
        client::load_membership(&db, &jp.class_id)
            .unwrap()
            .last_revision,
        0
    );
    real.running.unwrap().stop().await;
    impostor.running.unwrap().stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn connection_survives_many_concurrent_joins_without_exceeding_max_uses() {
    let a = start_admin().await;
    let inv = a.host.create_pairing(&a.device, 60_000, 3).unwrap();
    let jp = a.host.join_payload(&inv, vec![a.addr.clone()]).unwrap();
    let mut tasks = vec![];
    for i in 0..8 {
        let jp = jp.clone();
        tasks.push(tokio::spawn(async move {
            let db = Arc::new(Db::open_in_memory(CLASSROOM_MIGRATIONS).unwrap());
            sync::join_class(&db, &jp, &format!("S{i}")).await.is_ok()
        }));
    }
    let mut ok = 0;
    for t in tasks {
        if t.await.unwrap() {
            ok += 1;
        }
    }
    assert_eq!(ok, 3, "exactly max_uses joins may succeed");
    a.running.unwrap().stop().await;
}
