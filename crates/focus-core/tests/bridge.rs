use focus_core::bridge::*;
use focus_core::personal::PersonalStore;
use std::sync::Arc;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123";

async fn start() -> (Bridge, Arc<PersonalStore>, reqwest::Client, String) {
    let store = Arc::new(PersonalStore::open_in_memory().unwrap());
    let b = Bridge::start(TOKEN.into(), store.clone(), 0).await.unwrap();
    let url = format!("http://{}", b.addr);
    (
        b,
        store,
        reqwest::Client::builder().no_proxy().build().unwrap(),
        url,
    )
}

#[tokio::test]
async fn binds_loopback_only_and_requires_token() {
    let (b, _s, c, url) = start().await;
    assert!(b.addr.ip().is_loopback());
    assert_eq!(
        c.get(format!("{url}/v1/ping"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        c.get(format!("{url}/v1/rules"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        c.get(format!("{url}/v1/rules"))
            .bearer_auth("wrong")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        c.post(format!("{url}/v1/usage"))
            .body("{}")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    b.stop().await;
}

#[tokio::test]
async fn serves_rules_and_accumulates_measured_usage() {
    let (b, store, c, url) = start().await;
    b.set_rules(BridgeRules {
        revision: 3,
        day: "2026-10-29".into(),
        time_zone: "UTC".into(),
        reset_hour: 4,
        rules: vec![BridgeRule {
            platform: "youtube".into(),
            domains: vec!["youtube.com".into()],
            daily_limit_minutes: Some(30),
            blocked: false,
            self_reported_minutes: 0,
            allowed_windows: vec![],
            origin: "class".into(),
        }],
    });
    assert_eq!(
        b.extension_last_seen(),
        0,
        "never seen before an authenticated call"
    );
    let r: BridgeRules = c
        .get(format!("{url}/v1/rules"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(r.revision, 3);
    assert!(b.extension_last_seen() > 0);
    for secs in [120, 45] {
        let st = c
            .post(format!("{url}/v1/usage"))
            .bearer_auth(TOKEN)
            .json(&serde_json::json!({"day":"2026-10-29","platform":"youtube","seconds":secs}))
            .send()
            .await
            .unwrap()
            .status();
        assert_eq!(st, 204);
    }
    let u = store.measured_usage("2026-10-29", "2026-10-29").unwrap();
    assert_eq!(u.len(), 1);
    assert_eq!(u[0].seconds, 165);
    assert_eq!(u[0].source, "browser_extension");
    b.stop().await;
}

#[tokio::test]
async fn rejects_invalid_usage_reports() {
    let (b, store, c, url) = start().await;
    for body in [
        serde_json::json!({"day":"yesterday","platform":"youtube","seconds":5}),
        serde_json::json!({"day":"2026-10-29","platform":"You Tube","seconds":5}),
        serde_json::json!({"day":"2026-10-29","platform":"youtube","seconds":999999}),
        serde_json::json!({"day":"2026-10-29","platform":"youtube","seconds":-1}),
    ] {
        let st = c
            .post(format!("{url}/v1/usage"))
            .bearer_auth(TOKEN)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status();
        assert_eq!(st, 400, "{body}");
    }
    assert!(
        store
            .measured_usage("2000-01-01", "2100-01-01")
            .unwrap()
            .is_empty()
    );
    b.stop().await;
}
