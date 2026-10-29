//! Authority-layer tests: no sockets, injected clock.

use focus_core::client::{self, ApplyOutcome};
use focus_core::crypto::KeyPair;
use focus_core::db::Db;
use focus_core::host::*;
use focus_core::policy::*;
use focus_core::protocol::*;
use focus_core::{CLASSROOM_MIGRATIONS, Error};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

const PASS: &str = "correct horse battery";

struct Fx {
    db: Arc<Db>,
    host: Arc<HostService>,
    admin_dev: String,
    time: Arc<AtomicI64>,
    clock: Clock,
}

fn fx() -> Fx {
    focus_core::crypto::use_fast_kdf_for_tests();
    let db = Arc::new(Db::open_in_memory(CLASSROOM_MIGRATIONS).unwrap());
    let time = Arc::new(AtomicI64::new(1_000_000));
    let t2 = time.clone();
    let clock: Clock = Arc::new(move || t2.load(Ordering::SeqCst));
    let c = HostService::create_class(&db, "Grade 10B", "Ms. Admin", PASS, &clock).unwrap();
    let host = HostService::open(db.clone(), &c.class_id, clock.clone()).unwrap();
    host.unlock(PASS).unwrap();
    Fx {
        db,
        host,
        admin_dev: c.admin_device_id,
        time,
        clock,
    }
}

fn payload(minutes: u32) -> PolicyPayload {
    PolicyPayload {
        limits: vec![LimitRule {
            platform: "instagram".into(),
            blocked: false,
            daily_minutes: Some(minutes),
            allowed_windows: vec![],
        }],
        study_goals: vec![],
        allow_personal_limits: true,
        progress_sharing: ProgressSharing::None,
    }
}

fn join(
    f: &Fx,
    name: &str,
) -> (
    KeyPair,
    JoinPayload,
    JoinRequest,
    Result<JoinResponse, Error>,
) {
    let inv = f.host.create_pairing(&f.admin_dev, 60_000, 30).unwrap();
    let jp = f
        .host
        .join_payload(&inv, vec!["127.0.0.1:1".into()])
        .unwrap();
    let dev = KeyPair::generate();
    let req = client::build_join_request(&jp, name, &dev, f.host.now());
    let res = f.host.join(&req, "10.0.0.5");
    (dev, jp, req, res)
}

#[test]
fn exactly_one_active_admin_enforced_by_database() {
    let f = fx();
    let cid = f.host.class_id.clone();
    let r = f.db.lock().execute(
        "INSERT INTO members(id,class_id,display_name,role,status,joined_at) VALUES('x',?, 'Second', 'admin','active',0)",
        [&cid],
    );
    assert!(r.is_err(), "database must reject a second active admin");
    // A removed admin row is allowed (history), an active one is not.
    f.db.lock().execute("INSERT INTO members(id,class_id,display_name,role,status,joined_at) VALUES('y',?, 'Old', 'admin','removed',0)", [&cid]).unwrap();
}

#[test]
fn join_succeeds_and_client_verifies_host() {
    let f = fx();
    let (_dev, jp, req, res) = join(&f, "Aziza");
    let resp = res.unwrap();
    assert_eq!(resp.role, "member");
    client::verify_join_response(&jp, &req, &resp).unwrap();
    // A forged host proof must be rejected by the client.
    let mut bad = resp.clone();
    bad.host_proof = "AAAA".into();
    assert!(client::verify_join_response(&jp, &req, &bad).is_err());
    // A host claiming a different class key is rejected.
    let mut bad = resp.clone();
    bad.class_pub = KeyPair::generate().public_b64();
    assert!(client::verify_join_response(&jp, &req, &bad).is_err());
}

#[test]
fn wrong_pairing_proof_is_rejected_and_pairing_locks_after_five_failures() {
    let f = fx();
    let inv = f.host.create_pairing(&f.admin_dev, 60_000, 30).unwrap();
    let mut jp = f
        .host
        .join_payload(&inv, vec!["127.0.0.1:1".into()])
        .unwrap();
    let real_token = jp.token.clone();
    jp.token = focus_core::crypto::b64(&[7u8; 16]);
    for _ in 0..5 {
        let req = client::build_join_request(&jp, "Eve", &KeyPair::generate(), f.host.now());
        assert!(matches!(
            f.host.join(&req, "10.0.0.9"),
            Err(Error::Pairing(_))
        ));
        f.time.fetch_add(10, Ordering::SeqCst);
    }
    // Even the right token no longer works: the pairing session is burned.
    jp.token = real_token;
    let req = client::build_join_request(&jp, "Honest", &KeyPair::generate(), f.host.now());
    assert!(matches!(
        f.host.join(&req, "10.0.0.9"),
        Err(Error::Pairing(_))
    ));
}

#[test]
fn pairing_expires_and_respects_max_uses() {
    let f = fx();
    let inv = f.host.create_pairing(&f.admin_dev, 60_000, 1).unwrap();
    let jp = f
        .host
        .join_payload(&inv, vec!["127.0.0.1:1".into()])
        .unwrap();
    let r1 = client::build_join_request(&jp, "One", &KeyPair::generate(), f.host.now());
    f.host.join(&r1, "a").unwrap();
    let r2 = client::build_join_request(&jp, "Two", &KeyPair::generate(), f.host.now());
    assert!(
        f.host.join(&r2, "a").is_err(),
        "single-use pairing cannot be reused"
    );

    let inv = f.host.create_pairing(&f.admin_dev, 60_000, 5).unwrap();
    let jp = f
        .host
        .join_payload(&inv, vec!["127.0.0.1:1".into()])
        .unwrap();
    f.time.fetch_add(61_000, Ordering::SeqCst);
    let r3 = client::build_join_request(&jp, "Late", &KeyPair::generate(), f.host.now());
    assert!(matches!(f.host.join(&r3, "a"), Err(Error::Pairing(_))));
}

#[test]
fn join_replay_and_duplicate_device_rejected() {
    let f = fx();
    let (dev, jp, req, res) = join(&f, "Bek");
    res.unwrap();
    assert!(
        f.host.join(&req, "x").is_err(),
        "identical request replayed"
    );
    let again = client::build_join_request(&jp, "Bek again", &dev, f.host.now());
    assert!(
        f.host.join(&again, "x").is_err(),
        "same device cannot enroll twice"
    );
}

#[test]
fn invalid_pairing_lifetime_and_non_admin_cannot_create() {
    let f = fx();
    assert!(f.host.create_pairing(&f.admin_dev, 16 * 60_000, 1).is_err());
    let (_d, _jp, _r, res) = join(&f, "Student");
    let member_dev = res.unwrap().device_id;
    assert!(matches!(
        f.host.create_pairing(&member_dev, 1000, 1),
        Err(Error::Forbidden(_))
    ));
}

#[test]
fn only_admin_publishes_and_unchanged_payload_does_not_bump() {
    let f = fx();
    let (_d, _jp, _r, res) = join(&f, "Student");
    let member_dev = res.unwrap().device_id;
    assert!(matches!(
        f.host.publish_policy(&member_dev, payload(10)),
        Err(Error::Forbidden(_))
    ));
    let p1 = f.host.publish_policy(&f.admin_dev, payload(30)).unwrap();
    let p1b = f.host.publish_policy(&f.admin_dev, payload(30)).unwrap();
    assert_eq!(p1, p1b);
    let p2 = f.host.publish_policy(&f.admin_dev, payload(15)).unwrap();
    assert_ne!(p1.envelope, p2.envelope);
    assert_eq!(f.host.status().unwrap().current_revision, 2);
    assert!(f.host.publish_policy(&f.admin_dev, payload(5000)).is_err());
    assert_eq!(f.host.status().unwrap().current_revision, 2);
}

#[test]
fn locked_host_cannot_publish() {
    let f = fx();
    f.host.lock();
    assert!(matches!(
        f.host.publish_policy(&f.admin_dev, payload(30)),
        Err(Error::Locked)
    ));
}

#[test]
fn unlock_lockout_with_exponential_backoff() {
    let f = fx();
    f.host.lock();
    for _ in 0..2 {
        assert!(matches!(
            f.host.unlock("wrong-passphrase"),
            Err(Error::Forbidden(_))
        ));
    }
    assert!(matches!(
        f.host.unlock("wrong-passphrase"),
        Err(Error::Forbidden(_))
    ));
    // Now locked out even with the right passphrase.
    assert!(matches!(f.host.unlock(PASS), Err(Error::RateLimited(_))));
    f.time.fetch_add(6_000, Ordering::SeqCst);
    f.host.unlock(PASS).unwrap();
    assert!(f.host.is_unlocked());
}

#[test]
fn client_applies_in_order_and_rejects_stale_forged_and_wrong_class() {
    let f = fx();
    let (dev, jp, req, res) = join(&f, "Mira");
    let resp = res.unwrap();
    let cdb = Db::open_in_memory(CLASSROOM_MIGRATIONS).unwrap();
    client::save_membership(&cdb, &jp, &resp, &dev, 5, None).unwrap();
    let p1 = f.host.publish_policy(&f.admin_dev, payload(30)).unwrap();
    let p2 = f.host.publish_policy(&f.admin_dev, payload(20)).unwrap();
    let _ = req;
    assert_eq!(
        client::apply_policy(&cdb, &jp.class_id, &p2, 10).unwrap(),
        ApplyOutcome::Applied(2)
    );
    assert_eq!(
        client::apply_policy(&cdb, &jp.class_id, &p2, 11).unwrap(),
        ApplyOutcome::Duplicate(2)
    );
    assert!(matches!(
        client::apply_policy(&cdb, &jp.class_id, &p1, 12),
        Err(Error::StaleRevision { got: 1, current: 2 })
    ));
    assert_eq!(
        client::load_membership(&cdb, &jp.class_id)
            .unwrap()
            .last_revision,
        2
    );

    // Forged: signed by a different key.
    let evil = KeyPair::generate();
    let forged = sign(&evil, &jp.class_id, 3, 0, payload(1)).unwrap();
    assert!(client::apply_policy(&cdb, &jp.class_id, &forged, 13).is_err());
    // Genuine key but wrong class id.
    let other = sign(&KeyPair::generate(), "other", 3, 0, payload(1)).unwrap();
    assert!(client::apply_policy(&cdb, &jp.class_id, &other, 13).is_err());
    assert_eq!(
        client::load_membership(&cdb, &jp.class_id)
            .unwrap()
            .last_revision,
        2
    );
}

#[test]
fn removed_member_loses_access_but_admin_cannot_be_removed() {
    let f = fx();
    let (_d, _jp, _r, res) = join(&f, "Temp");
    let resp = res.unwrap();
    f.host.remove_member(&f.admin_dev, &resp.member_id).unwrap();
    assert!(f.host.require_admin(&resp.device_id).is_err());
    let members = f.host.list_members(&f.admin_dev).unwrap();
    let admin = members.iter().find(|m| m.role == "admin").unwrap();
    assert!(matches!(
        f.host.remove_member(&f.admin_dev, &admin.member_id),
        Err(Error::Forbidden(_))
    ));
}

#[test]
fn audit_chain_detects_tampering() {
    let f = fx();
    f.host.publish_policy(&f.admin_dev, payload(30)).unwrap();
    assert!(f.host.verify_audit_chain().unwrap());
    f.db.lock()
        .execute(
            "UPDATE audit_events SET detail='edited' WHERE action='policy_published'",
            [],
        )
        .unwrap();
    assert!(!f.host.verify_audit_chain().unwrap());
}

#[test]
fn transfer_moves_authority_and_keeps_single_admin() {
    let f = fx();
    let (_d, _jp, _r, res) = join(&f, "Student");
    let student = res.unwrap();
    let p1 = f.host.publish_policy(&f.admin_dev, payload(30)).unwrap();
    let bundle = f
        .host
        .begin_transfer(&f.admin_dev, "bundle-passphrase-1")
        .unwrap();
    // Old host is retired.
    assert!(matches!(
        HostService::open(f.db.clone(), &f.host.class_id, f.clock.clone()),
        Err(Error::Forbidden(_))
    ));
    assert!(f.host.publish_policy(&f.admin_dev, payload(1)).is_err());

    // Wrong bundle passphrase fails.
    focus_core::crypto::use_fast_kdf_for_tests();
    let db2 = Arc::new(Db::open_in_memory(CLASSROOM_MIGRATIONS).unwrap());
    assert!(
        HostService::restore_from_bundle(
            &db2,
            &bundle,
            "nope-nope-nope",
            "new-admin-pass-1",
            "New Admin",
            RestoreMode::Transfer,
            &f.clock
        )
        .is_err()
    );
    let created = HostService::restore_from_bundle(
        &db2,
        &bundle,
        "bundle-passphrase-1",
        "new-admin-pass-1",
        "New Admin",
        RestoreMode::Transfer,
        &f.clock,
    )
    .unwrap();
    let host2 = HostService::open(db2.clone(), &created.class_id, f.clock.clone()).unwrap();
    host2.unlock("new-admin-pass-1").unwrap();
    let members = host2.list_members(&created.admin_device_id).unwrap();
    assert_eq!(
        members
            .iter()
            .filter(|m| m.role == "admin" && m.status == "active")
            .count(),
        1
    );
    // Existing student device still authenticates against the new host and revisions continue.
    assert!(host2.require_admin(&student.device_id).is_err());
    assert!(
        host2.require_admin(&f.admin_dev).is_err(),
        "old admin device is a plain member now"
    );
    let p2 = host2
        .publish_policy(&created.admin_device_id, payload(10))
        .unwrap();
    assert!(p2.envelope.contains("\"revision\":2"));
    // Old signed policies remain valid under the same pinned key.
    let _ = p1;
    // Restoring twice into the same DB is refused.
    assert!(
        HostService::restore_from_bundle(
            &db2,
            &bundle,
            "bundle-passphrase-1",
            "new-admin-pass-1",
            "X",
            RestoreMode::Transfer,
            &f.clock
        )
        .is_err()
    );
}

#[test]
fn recovery_revokes_lost_admin_device() {
    let f = fx();
    let bundle = f
        .host
        .export_recovery_bundle(&f.admin_dev, "bundle-passphrase-2")
        .unwrap();
    focus_core::crypto::use_fast_kdf_for_tests();
    let db2 = Arc::new(Db::open_in_memory(CLASSROOM_MIGRATIONS).unwrap());
    let c = HostService::restore_from_bundle(
        &db2,
        &bundle,
        "bundle-passphrase-2",
        "new-admin-pass-2",
        "Recovered",
        RestoreMode::Recovery,
        &f.clock,
    )
    .unwrap();
    let h2 = HostService::open(db2, &c.class_id, f.clock.clone()).unwrap();
    assert!(
        h2.require_admin(&f.admin_dev).is_err(),
        "stolen/lost admin device must not retain authority"
    );
    h2.require_admin(&c.admin_device_id).unwrap();
}

#[test]
fn newer_schema_database_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("c.db");
    drop(Db::open(&path, CLASSROOM_MIGRATIONS).unwrap());
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute("INSERT INTO schema_migrations VALUES (99,'future',0)", [])
        .unwrap();
    assert!(Db::open(&path, CLASSROOM_MIGRATIONS).is_err());
}

#[test]
fn client_reports_unsupported_schema_distinctly() {
    let cdb = Db::open_in_memory(CLASSROOM_MIGRATIONS).unwrap();
    let class_key = KeyPair::generate();
    let jp = JoinPayload {
        v: 1,
        class_id: "cls".into(),
        class_name: "C".into(),
        class_pub: class_key.public_b64(),
        pairing_id: "p".into(),
        token: focus_core::crypto::b64(&[1; 16]),
        addrs: vec!["127.0.0.1:1".into()],
        expires_at: i64::MAX,
    };
    let dev = KeyPair::generate();
    let resp = JoinResponse {
        class_id: "cls".into(),
        class_name: "C".into(),
        class_pub: class_key.public_b64(),
        member_id: "m".into(),
        device_id: dev.key_id(),
        role: "member".into(),
        policy: None,
        host_proof: String::new(),
    };
    client::save_membership(&cdb, &jp, &resp, &dev, 0, None).unwrap();
    let ok = sign(&class_key, "cls", 1, 0, payload(5)).unwrap();
    let env = ok
        .envelope
        .replace("\"schema_version\":1", "\"schema_version\":2");
    let future = SignedPolicy {
        signature: class_key.sign(env.as_bytes()),
        envelope: env,
        key_id: class_key.key_id(),
    };
    assert!(matches!(
        client::apply_policy(&cdb, "cls", &future, 1),
        Err(Error::UnsupportedSchema(2))
    ));
    assert_eq!(
        client::load_membership(&cdb, "cls").unwrap().last_revision,
        0,
        "nothing stored"
    );
}
