//! Dev/e2e harness: runs the REAL extension bridge on a loopback port with a given token and
//! rules file, and prints measured usage lines so an external test can observe what arrived.
//!   cargo run -p focus-core --example bridge_dev -- <token> <rules.json> [port]
use focus_core::bridge::{Bridge, BridgeRules};
use focus_core::personal::PersonalStore;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let token = args.get(1).expect("token").clone();
    let rules: BridgeRules =
        serde_json::from_str(&std::fs::read_to_string(args.get(2).expect("rules.json")).unwrap())
            .unwrap();
    let port: u16 = args.get(3).and_then(|p| p.parse().ok()).unwrap_or(0);
    let store = Arc::new(PersonalStore::open_in_memory().unwrap());
    let bridge = Bridge::start(token, store.clone(), port).await.unwrap();
    bridge.set_rules(rules.clone());
    println!("ADDR http://{}", bridge.addr);
    let rules_path = args.get(2).unwrap().clone();
    let mut last_mtime = std::fs::metadata(&rules_path)
        .and_then(|m| m.modified())
        .ok();
    loop {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        // Hot-reload the rules file so the test can change rules while the app "runs".
        let m = std::fs::metadata(&rules_path)
            .and_then(|m| m.modified())
            .ok();
        if m != last_mtime {
            last_mtime = m;
            if let Ok(t) = std::fs::read_to_string(&rules_path)
                && let Ok(r) = serde_json::from_str::<BridgeRules>(&t)
            {
                bridge.set_rules(r);
                println!("RULES reloaded");
            }
        }
        let usage = store.measured_usage("2000-01-01", "2999-12-31").unwrap();
        println!(
            "USAGE {} LASTSEEN {}",
            serde_json::to_string(&usage).unwrap(),
            bridge.extension_last_seen()
        );
    }
}
