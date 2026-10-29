//! Real processes: the monitor finds a running program, warns, then really ends it.

use focus_core::apps::{AppMonitor, AppRule, AppsPolicy, Mode, Notice, ProcessSource, SysProcesses};
use focus_core::personal::PersonalStore;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// A harmless program with a name of its own: a copy of this very test executable that just sleeps.
/// (Not `sleep`/`ping`: those live in system folders, which FOCUS OS refuses to touch, and ending a shared
/// name would end every copy running on the machine.) Returns the child and its app slug.
fn spawn_victim() -> (Child, String, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("focus-victim-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let name = format!("focus-victim-{}{ext}", std::process::id());
    let copy = dir.join(&name);
    std::fs::copy(std::env::current_exe().unwrap(), &copy).unwrap();
    let child = Command::new(&copy)
        .args(["--ignored", "--exact", "victim_sleeper", "--nocapture"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start the victim");
    let slug = focus_core::apps::slug(&name);
    // Wait (up to 20 s; Windows starts programs slowly) until the operating system actually lists the victim.
    let started = Instant::now();
    let mut src = SysProcesses::new();
    while started.elapsed() < Duration::from_secs(20) {
        if src.list().iter().any(|p| p.name.to_lowercase().starts_with("focus-victim") || p.exe.as_deref().is_some_and(|e| e.contains(&name))) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    (child, slug, dir)
}

/// Only ever run as the "victim" process above.
#[test]
#[ignore]
fn victim_sleeper() {
    std::thread::sleep(Duration::from_secs(300));
}

/// Every test uses the same program name, and ending "sleep" ends all of them, so the tests run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());
fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn monitor() -> (Arc<AppMonitor>, Arc<PersonalStore>) {
    let store = Arc::new(PersonalStore::open_in_memory().unwrap());
    (AppMonitor::new(store.clone(), Box::new(SysProcesses::new())), store)
}

fn policy(slug: &str, blocked: bool, mode: Mode) -> AppsPolicy {
    AppsPolicy {
        day: "2026-01-05".into(),
        mode,
        rules: vec![AppRule { slug: slug.into(), label: slug.into(), blocked_now: blocked, why: "Blocked by your class".into(), budget_secs: None, extra_used_secs: 0, allowed_until_ms: None }],
    }
}

fn wait_exit(c: &mut Child, secs: u64) -> bool {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(secs) {
        if c.try_wait().unwrap().is_some() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
fn a_blocked_program_is_warned_then_really_closed_and_its_open_time_is_recorded() {
    let _g = serial();
    let (mut child, slug, dir) = spawn_victim();
    let slug = slug.as_str();
    let (m, store) = monitor();
    m.push(policy(slug, true, Mode::Close)).unwrap();
    let seen = Mutex::new(Vec::<Notice>::new());
    let sink = |n: Notice| seen.lock().unwrap().push(n);

    m.step(0, &sink);
    assert!(matches!(seen.lock().unwrap()[0], Notice::Closing { seconds_left: 60, .. }), "{:?}", seen.lock().unwrap());
    assert!(child.try_wait().unwrap().is_none(), "nothing is closed during the grace period");
    m.step(30_000, &sink);
    assert!(child.try_wait().unwrap().is_none());

    m.step(61_000, &sink);
    assert!(seen.lock().unwrap().iter().any(|n| matches!(n, Notice::Closed { .. })));
    assert!(wait_exit(&mut child, 10), "the program should have been ended");

    // Open time (30 s counted between the two earlier steps) was stored, not invented.
    let used = store.app_usage("2026-01-05").unwrap();
    assert!(used.iter().any(|(a, s)| a == slug && *s >= 30), "{used:?}");
    assert_eq!(m.status().usage.len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn remind_only_never_ends_the_program() {
    let _g = serial();
    let (mut child, slug, dir) = spawn_victim();
    let slug = slug.as_str();
    let (m, _) = monitor();
    m.push(policy(slug, true, Mode::Remind)).unwrap();
    let seen = Mutex::new(Vec::<Notice>::new());
    let sink = |n: Notice| seen.lock().unwrap().push(n);
    for t in [0, 61_000, 130_000] {
        m.step(t, &sink);
    }
    assert!(seen.lock().unwrap().iter().any(|n| matches!(n, Notice::Over { .. })));
    assert!(!seen.lock().unwrap().iter().any(|n| matches!(n, Notice::Closed { .. })));
    assert!(child.try_wait().unwrap().is_none());
    child.kill().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_app_list_shows_running_programs_and_hides_protected_ones() {
    let _g = serial();
    let (mut child, slug, dir) = spawn_victim();
    let slug = slug.as_str();
    let (m, _) = monitor();
    let apps = m.list();
    assert!(apps.iter().any(|a| a.slug == slug && a.running), "{:?}", apps.iter().map(|a| &a.slug).collect::<Vec<_>>());
    for hidden in ["systemd", "explorer", "bash", "chrome", "focus-os"] {
        assert!(!apps.iter().any(|a| a.slug == hidden), "{hidden} must never be offered");
    }
    child.kill().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn rules_for_protected_programs_are_ignored_and_reported() {
    let (m, _) = monitor();
    m.push(policy("explorer", true, Mode::Close)).unwrap();
    assert_eq!(m.status().ignored, vec!["explorer".to_string()]);
    assert!(m.push(AppsPolicy { day: "bad".into(), mode: Mode::Close, rules: vec![] }).is_err());
}
