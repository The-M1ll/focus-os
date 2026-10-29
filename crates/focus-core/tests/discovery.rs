//! Needs working multicast on the machine; run with `cargo test -- --ignored`.
use focus_core::discovery::*;
use std::time::Duration;

#[test]
#[ignore = "requires multicast-capable network interface"]
fn advertise_then_browse_finds_class() {
    let ip = focus_core::netinfo::lan_addresses()
        .first()
        .map(|a| a.ip.parse().unwrap())
        .expect("no LAN address");
    let cid = "abcdef0123456789abcdef0123456789";
    let _adv = Advertiser::start(cid, ip, 47801).unwrap();
    let found = browse(Duration::from_secs(5), Some(cid)).unwrap();
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].addrs.iter().any(|a| a.ends_with(":47801")));
}

/// A member whose stored host address is stale finds the host again by class id and reconnects.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires multicast-capable network interface"]
async fn member_rediscovers_host_after_address_change() {
    use focus_core::client;
    use focus_core::db::Db;
    use focus_core::host::*;
    use focus_core::sync::{self, ClassSync, SyncState};
    use focus_core::{CLASSROOM_MIGRATIONS, server};
    use std::sync::Arc;
    use tokio::sync::watch;

    focus_core::crypto::use_fast_kdf_for_tests();
    let lan: std::net::IpAddr = focus_core::netinfo::lan_addresses()
        .first()
        .expect("no LAN address")
        .ip
        .parse()
        .unwrap();
    let hdb = Arc::new(Db::open_in_memory(CLASSROOM_MIGRATIONS).unwrap());
    let clock = system_clock();
    let c = HostService::create_class(&hdb, "Rediscover", "T", "correct horse battery", &clock)
        .unwrap();
    let host = HostService::open(hdb.clone(), &c.class_id, clock).unwrap();
    host.unlock("correct horse battery").unwrap();
    let l = server::bind_listener(lan, Some(0)).await.unwrap();
    let running = server::serve(host.clone(), l).await.unwrap();
    let real = running.addr.to_string();
    let _adv =
        focus_core::discovery::Advertiser::start(&c.class_id, lan, running.addr.port()).unwrap();

    let inv = host.create_pairing(&c.admin_device_id, 60_000, 5).unwrap();
    let jp = host.join_payload(&inv, vec![real.clone()]).unwrap();
    let mdb = Arc::new(Db::open_in_memory(CLASSROOM_MIGRATIONS).unwrap());
    sync::join_class(&mdb, &jp, "Aziza").await.unwrap();
    // The host "moves": the member now only knows a dead address.
    client::set_host_addrs(&mdb, &c.class_id, &["127.0.0.1:1".to_string()]).unwrap();

    let s = ClassSync::new(mdb.clone(), &c.class_id).unwrap();
    let (tx, rx) = watch::channel(false);
    let h = tokio::spawn(s.clone().run(rx));
    let start = std::time::Instant::now();
    while start.elapsed() < std::time::Duration::from_secs(30)
        && s.status().state != SyncState::Live
    {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(
        s.status().state,
        SyncState::Live,
        "member should have found the host again"
    );
    assert_eq!(
        client::load_membership(&mdb, &c.class_id)
            .unwrap()
            .host_addrs,
        vec![real]
    );
    tx.send(true).unwrap();
    h.await.unwrap();
    running.stop().await;
}
