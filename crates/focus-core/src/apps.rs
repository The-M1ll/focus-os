//! Desktop-app limits: discovery of apps, "open time" accounting and warn-then-close enforcement.
//!
//! What is measured is **time an app's process is running** (not time it is the focused window).
//! What is enforced is closing that process after a visible warning. Both are per-device and local:
//! nothing here talks to the network, and class rules arrive through the normal signed policy.
//!
//! The decision logic (`Enforcer`) is pure and driven by an injected clock and process list, so it is
//! unit-tested without touching real processes. `AppMonitor` is the thin loop that feeds it real ones.

use crate::error::Result;
use crate::personal::PersonalStore;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Seconds between process scans.
pub const TICK_SECS: u64 = 5;
/// A longer gap between ticks (sleep, suspend) is not counted as use.
const MAX_COUNTED_GAP_SECS: u64 = 30;
/// Grace period before an app is closed when its time is up and no earlier warning was given.
pub const GRACE_FIRST_SECS: u64 = 60;
/// Grace when the student was already warned (or reopened the app shortly after it was closed).
pub const GRACE_REPEAT_SECS: u64 = 10;
/// Seconds after a polite close request before the process is ended forcibly.
const FORCE_AFTER_SECS: i64 = 20;
const REOPEN_WINDOW_MS: i64 = 5 * 60_000;
const LOW_WARNING_SECS: u64 = 60;

// ---- naming ----------------------------------------------------------------------------------

/// Lower-case, hyphen-separated identifier of an app name. `"Epic Games Launcher.exe"` -> `epic-games-launcher`.
pub fn slug(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    let stem = ["exe", "app", "bin", "desktop"]
        .iter()
        .find_map(|ext| lower.strip_suffix(&format!(".{ext}")))
        .unwrap_or(&lower);
    let mut out = String::new();
    let mut dash = true;
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.truncate(56);
    out
}

/// The rule/platform id used in policies and personal limits for an app.
pub fn rule_id(slug: &str) -> String {
    format!("app.{slug}")
}

pub struct Known {
    pub slug: &'static str,
    pub name: &'static str,
    /// Process-name slugs that belong to this app (the slug itself always matches).
    pub processes: &'static [&'static str],
    pub game: bool,
}

/// Well-known apps whose process names differ from their display name. Entries are best-effort;
/// anything not listed matches by its own process name.
pub const KNOWN: &[Known] = &[
    Known { slug: "steam", name: "Steam", processes: &["steam", "steamwebhelper", "steam-exe"], game: true },
    Known { slug: "epic-games-launcher", name: "Epic Games Launcher", processes: &["epicgameslauncher", "epicwebhelper"], game: true },
    Known { slug: "roblox", name: "Roblox", processes: &["robloxplayerbeta", "robloxplayer", "roblox", "robloxstudiobeta"], game: true },
    Known { slug: "minecraft-launcher", name: "Minecraft Launcher", processes: &["minecraft-launcher", "minecraftlauncher", "minecraft"], game: true },
    Known { slug: "fortnite", name: "Fortnite", processes: &["fortniteclient-win64-shipping", "fortnitelauncher"], game: true },
    Known { slug: "valorant", name: "Valorant", processes: &["valorant", "valorant-win64-shipping"], game: true },
    Known { slug: "league-of-legends", name: "League of Legends", processes: &["leagueclient", "leagueclientux", "league-of-legends"], game: true },
    Known { slug: "counter-strike-2", name: "Counter-Strike 2", processes: &["cs2"], game: true },
    Known { slug: "dota-2", name: "Dota 2", processes: &["dota2"], game: true },
    Known { slug: "genshin-impact", name: "Genshin Impact", processes: &["genshinimpact", "yuanshen"], game: true },
    Known { slug: "battle-net", name: "Battle.net", processes: &["battle-net"], game: true },
    Known { slug: "discord", name: "Discord", processes: &["discord"], game: false },
    Known { slug: "spotify", name: "Spotify", processes: &["spotify"], game: false },
];

pub fn known(slug: &str) -> Option<&'static Known> {
    KNOWN.iter().find(|k| k.slug == slug)
}

/// Every process-name slug that counts as use of the app `slug`.
pub fn process_slugs(slug: &str) -> Vec<String> {
    let mut v = vec![slug.to_string()];
    if let Some(k) = known(slug) {
        v.extend(k.processes.iter().map(|s| s.to_string()));
    }
    v.sort();
    v.dedup();
    v
}

pub fn display_name(slug: &str) -> String {
    if let Some(k) = known(slug) {
        return k.name.to_string();
    }
    slug.split('-')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ---- safety ----------------------------------------------------------------------------------

const PROTECTED: &[&str] = &[
    // operating system / shell
    "explorer", "finder", "dock", "loginwindow", "systemuiserver", "windowserver", "launchd", "kernel-task",
    "svchost", "csrss", "winlogon", "dwm", "lsass", "services", "system", "smss", "wininit", "taskmgr",
    "systemd", "init", "gnome-shell", "kwin-x11", "kwin-wayland", "plasmashell", "xorg", "xwayland", "mutter",
    "sshd", "dbus-daemon", "pulseaudio", "pipewire", "networkmanager", "activity-monitor", "task-manager",
    // terminals and shells (a student may be doing homework in them)
    "terminal", "iterm2", "cmd", "powershell", "pwsh", "conhost", "windowsterminal", "bash", "zsh", "fish", "sh",
    // browsers are limited per website by the extension, never killed here
    "chrome", "google-chrome", "chromium", "msedge", "microsoft-edge", "firefox", "safari", "brave", "brave-browser", "arc", "opera", "vivaldi",
    // this app
    "focus-os", "focus-os-lib",
];

const SYSTEM_PATH_PREFIXES: &[&str] = &["/system/", "/usr/libexec/", "/usr/sbin/", "/sbin/", "/bin/", "c:\\windows\\", "c:/windows/"];

/// Processes that can never be limited or closed: the OS, shells, browsers and this app.
pub fn is_protected(slug: &str, exe: Option<&str>) -> bool {
    if slug.is_empty() || PROTECTED.contains(&slug) {
        return true;
    }
    if let Some(p) = exe {
        let lower = p.to_lowercase();
        if SYSTEM_PATH_PREFIXES.iter().any(|pre| lower.starts_with(pre)) {
            return true;
        }
    }
    false
}

// ---- processes -------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub exe: Option<String>,
}

pub trait ProcessSource: Send {
    fn list(&mut self) -> Vec<ProcInfo>;
    /// Ask a process to end (`force = false`: polite request where the OS supports one). True if the request was delivered.
    fn terminate(&mut self, pid: u32, force: bool) -> bool;
}

pub struct SysProcesses {
    sys: Option<sysinfo::System>,
}

impl SysProcesses {
    pub fn new() -> Self {
        Self { sys: sysinfo::System::new().ok() }
    }
}

impl Default for SysProcesses {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessSource for SysProcesses {
    fn list(&mut self) -> Vec<ProcInfo> {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, UpdateKind};
        let Some(sys) = self.sys.as_mut() else { return Vec::new() };
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
        );
        sys.processes()
            .iter()
            .map(|(pid, p)| ProcInfo {
                pid: pid.as_u32(),
                name: p.name().to_string_lossy().into_owned(),
                exe: p.exe().map(|e| e.to_string_lossy().into_owned()),
            })
            .collect()
    }

    fn terminate(&mut self, pid: u32, force: bool) -> bool {
        let Some(p) = self.sys.as_ref().and_then(|s| s.process(sysinfo::Pid::from_u32(pid))) else {
            return false;
        };
        if force {
            return p.kill();
        }
        match p.kill_with(sysinfo::Signal::Term) {
            Some(ok) => ok,
            None => p.kill(), // no polite signal on this OS (Windows)
        }
    }
}

/// File name of the executable, when the OS tells us. Linux truncates a process *name* to 15 characters, so the
/// executable's own file name is the more reliable identity.
fn exe_slug(p: &ProcInfo) -> Option<String> {
    let exe = p.exe.as_deref()?;
    let file = exe.rsplit(['/', '\\']).next()?;
    let s = slug(file);
    (!s.is_empty()).then_some(s)
}

/// The identity shown in the list: the executable's file name if known, else the process name.
fn proc_slug(p: &ProcInfo) -> String {
    exe_slug(p).unwrap_or_else(|| slug(&p.name))
}

/// Every identity a rule may match against (process name and executable file name).
fn proc_identities(p: &ProcInfo) -> Vec<String> {
    let mut v = vec![slug(&p.name)];
    if let Some(e) = exe_slug(p)
        && !v.contains(&e)
    {
        v.push(e);
    }
    v.retain(|s| !s.is_empty());
    v
}

// ---- app list for the UI ---------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AppEntry {
    pub slug: String,
    pub name: String,
    pub running: bool,
    pub installed: bool,
    /// Matched against the curated list of games/launchers.
    pub game: bool,
}

#[derive(Clone, Debug)]
pub struct Installed {
    pub name: String,
    /// Process-name slug when known (Linux `Exec=`), else derived from the display name.
    pub slug: String,
    pub game: bool,
}

pub fn list_apps(src: &mut dyn ProcessSource, installed: &[Installed]) -> Vec<AppEntry> {
    let mut map: HashMap<String, AppEntry> = HashMap::new();
    // Known apps are listed under their canonical slug whether they are installed, running or neither.
    for p in src.list() {
        let ps = proc_slug(&p);
        if is_protected(&ps, p.exe.as_deref()) || p.exe.is_none() {
            continue;
        }
        let canon = KNOWN.iter().find(|k| k.slug == ps || k.processes.contains(&ps.as_str())).map(|k| k.slug.to_string()).unwrap_or(ps);
        let e = map.entry(canon.clone()).or_insert_with(|| AppEntry {
            name: display_name(&canon),
            game: known(&canon).is_some_and(|k| k.game),
            slug: canon,
            running: false,
            installed: false,
        });
        e.running = true;
    }
    for i in installed {
        let s = KNOWN
            .iter()
            .find(|k| k.slug == i.slug || k.processes.contains(&i.slug.as_str()) || k.slug == slug(&i.name))
            .map(|k| k.slug.to_string())
            .unwrap_or_else(|| i.slug.clone());
        if is_protected(&s, None) {
            continue;
        }
        let e = map.entry(s.clone()).or_insert_with(|| AppEntry {
            name: i.name.clone(),
            slug: s.clone(),
            running: false,
            installed: false,
            game: false,
        });
        e.installed = true;
        e.game |= i.game || known(&s).is_some_and(|k| k.game);
    }
    let mut v: Vec<AppEntry> = map.into_values().collect();
    v.sort_by(|a, b| b.game.cmp(&a.game).then(b.running.cmp(&a.running)).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    v.truncate(500);
    v
}

/// Apps installed on this computer, best effort per OS. Returns an empty list where nothing can be read.
pub fn scan_installed() -> Vec<Installed> {
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    for dir in ["/Applications", "/Applications/Utilities"] {
        scan_dir_ext(Path::new(dir), "app", &mut out);
    }
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        scan_dir_ext(&Path::new(&home).join("Applications"), "app", &mut out);
    }
    #[cfg(target_os = "windows")]
    for var in ["ProgramData", "APPDATA"] {
        if let Some(base) = std::env::var_os(var) {
            scan_tree_ext(&Path::new(&base).join("Microsoft\\Windows\\Start Menu\\Programs"), "lnk", 3, &mut out);
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut dirs = vec![std::path::PathBuf::from("/usr/share/applications"), std::path::PathBuf::from("/var/lib/flatpak/exports/share/applications")];
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(Path::new(&home).join(".local/share/applications"));
        }
        for d in dirs {
            scan_desktop_files(&d, &mut out);
        }
    }
    let mut seen = HashSet::new();
    out.retain(|i| !i.slug.is_empty() && seen.insert(i.slug.clone()));
    out
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn scan_dir_ext(dir: &Path, ext: &str, out: &mut Vec<Installed>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case(ext)) {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    out.push(Installed { name: stem.to_string(), slug: slug(stem), game: false });
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn scan_tree_ext(dir: &Path, ext: &str, depth: u8, out: &mut Vec<Installed>) {
    scan_dir_ext(dir, ext, out);
    if depth == 0 {
        return;
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                scan_tree_ext(&e.path(), ext, depth - 1, out);
            }
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn scan_desktop_files(dir: &Path, out: &mut Vec<Installed>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("desktop") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        if let Some(i) = parse_desktop_entry(&text) {
            out.push(i);
        }
    }
}

/// Parses the `[Desktop Entry]` section of a freedesktop `.desktop` file.
pub fn parse_desktop_entry(text: &str) -> Option<Installed> {
    let mut in_entry = false;
    let (mut name, mut exec, mut hidden, mut game, mut not_app) = (None, None, false, false, false);
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_entry = l == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        if let Some(v) = l.strip_prefix("Name=") {
            name.get_or_insert(v.to_string());
        } else if let Some(v) = l.strip_prefix("Exec=") {
            exec.get_or_insert(v.to_string());
        } else if l == "NoDisplay=true" || l == "Hidden=true" {
            hidden = true;
        } else if let Some(v) = l.strip_prefix("Categories=") {
            game = v.split(';').any(|c| c == "Game");
        } else if let Some(v) = l.strip_prefix("Type=") {
            not_app = v != "Application";
        }
    }
    if not_app {
        return None;
    }
    if hidden {
        return None;
    }
    let name = name?;
    let exec = exec?;
    // First word of Exec (skip `env VAR=x` prefixes), reduced to its file name.
    let mut words = exec.split_whitespace().filter(|w| !w.contains('='));
    let mut first = words.next()?;
    if first == "env" {
        first = words.next()?;
    }
    let base = first.trim_matches('"').rsplit('/').next()?.to_string();
    let s = slug(&base);
    if s.is_empty() {
        return None;
    }
    Some(Installed { name, slug: s, game })
}

// ---- policy and enforcement ------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Off,
    Remind,
    #[default]
    Close,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct AppRule {
    pub slug: String,
    pub label: String,
    /// Not usable at all right now (class block, or outside the allowed hours).
    pub blocked_now: bool,
    /// Plain-words reason shown in warnings, e.g. "Blocked by your class" or "Outside allowed hours".
    #[serde(default)]
    pub why: String,
    /// Total seconds allowed today; `None` = no budget.
    pub budget_secs: Option<u64>,
    /// Seconds the student reported themselves; counted against the budget.
    #[serde(default)]
    pub extra_used_secs: u64,
    /// Unix ms when the allowed hours end; `None` = no end in sight.
    pub allowed_until_ms: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct AppsPolicy {
    /// Study day key (`YYYY-MM-DD`) the budgets belong to.
    pub day: String,
    #[serde(default)]
    pub mode: Mode,
    pub rules: Vec<AppRule>,
}

impl AppsPolicy {
    pub fn validate(&self) -> Result<()> {
        let ok_day = self.day.len() == 10 && self.day.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
        if !ok_day {
            return Err(crate::Error::invalid("day must be YYYY-MM-DD"));
        }
        if self.rules.len() > 200 {
            return Err(crate::Error::invalid("too many app rules"));
        }
        for r in &self.rules {
            if r.slug.is_empty() || r.slug.len() > 56 || !r.slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
                return Err(crate::Error::invalid(format!("invalid app id {:?}", r.slug)));
            }
            if r.label.len() > 80 || r.why.len() > 120 {
                return Err(crate::Error::invalid("label or reason too long"));
            }
        }
        Ok(())
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Notice {
    /// The app will be closed in `seconds_left` unless it is closed first.
    Closing { slug: String, label: String, seconds_left: u64, why: String },
    /// Time is running out (budget) - nothing closes yet.
    LowTime { slug: String, label: String, seconds_left: u64 },
    /// A polite close request was sent.
    Closed { slug: String, label: String, why: String },
    /// Remind mode: the limit is over, nothing was closed.
    Over { slug: String, label: String, why: String },
}

#[derive(Debug, PartialEq)]
pub struct Kill {
    pub slug: String,
    pub pids: Vec<u32>,
    pub force: bool,
}

#[derive(Default, Debug)]
pub struct TickOutput {
    pub notices: Vec<Notice>,
    pub kills: Vec<Kill>,
    /// Seconds of open time to add to today's usage, per app.
    pub usage: Vec<(String, u64)>,
}

#[derive(Default)]
struct AppState {
    deadline_ms: Option<i64>,
    low_warned: bool,
    close_sent_ms: Option<i64>,
    last_warn_ms: Option<i64>,
    last_over_note_ms: Option<i64>,
}

#[derive(Default)]
pub struct Enforcer {
    policy: AppsPolicy,
    used: HashMap<String, u64>,
    state: HashMap<String, AppState>,
    last_tick_ms: Option<i64>,
    pub last_scan_ms: i64,
    pub ignored: Vec<String>,
}

impl Enforcer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn day(&self) -> &str {
        &self.policy.day
    }

    pub fn mode(&self) -> Mode {
        self.policy.mode
    }

    /// Install a policy. `used` = seconds already recorded today per app (from storage) when the day changes.
    pub fn set_policy(&mut self, mut p: AppsPolicy, used_today: Option<HashMap<String, u64>>) {
        self.ignored = p.rules.iter().filter(|r| is_protected(&r.slug, None)).map(|r| r.slug.clone()).collect();
        p.rules.retain(|r| !is_protected(&r.slug, None));
        if p.day != self.policy.day {
            self.used = used_today.unwrap_or_default();
            self.state.clear();
        }
        self.policy = p;
    }

    pub fn used_secs(&self, slug: &str) -> u64 {
        self.used.get(slug).copied().unwrap_or(0)
    }

    fn left_secs(&self, r: &AppRule, now_ms: i64) -> u64 {
        if r.blocked_now {
            return 0;
        }
        let mut left = u64::MAX;
        if let Some(b) = r.budget_secs {
            left = left.min(b.saturating_sub(self.used_secs(&r.slug) + r.extra_used_secs));
        }
        if let Some(u) = r.allowed_until_ms {
            left = left.min(((u - now_ms).max(0) / 1000) as u64);
        }
        left
    }

    /// Advance the clock. `running` maps an app slug to the pids currently matching it.
    pub fn tick(&mut self, now_ms: i64, running: &HashMap<String, Vec<u32>>) -> TickOutput {
        let mut out = TickOutput::default();
        let dt = match self.last_tick_ms {
            Some(t) => ((now_ms - t).max(0) as u64 / 1000).min(MAX_COUNTED_GAP_SECS),
            None => 0,
        };
        self.last_tick_ms = Some(now_ms);
        let mode = self.policy.mode;
        let rules = self.policy.rules.clone();
        for r in &rules {
            let pids = running.get(&r.slug).filter(|v| !v.is_empty());
            let Some(pids) = pids else {
                // Not running: forget any pending close, keep the "recently warned" memory.
                if let Some(st) = self.state.get_mut(&r.slug) {
                    st.deadline_ms = None;
                    st.close_sent_ms = None;
                }
                continue;
            };
            if dt > 0 {
                *self.used.entry(r.slug.clone()).or_insert(0) += dt;
                out.usage.push((r.slug.clone(), dt));
            }
            if mode == Mode::Off {
                continue;
            }
            let left = self.left_secs(r, now_ms);
            let st = self.state.entry(r.slug.clone()).or_default();
            if left > 0 {
                st.deadline_ms = None;
                st.close_sent_ms = None;
                if left <= LOW_WARNING_SECS && left != u64::MAX {
                    if !st.low_warned {
                        st.low_warned = true;
                        st.last_warn_ms = Some(now_ms);
                        out.notices.push(Notice::LowTime { slug: r.slug.clone(), label: r.label.clone(), seconds_left: left });
                    }
                } else if left > LOW_WARNING_SECS {
                    st.low_warned = false;
                }
                continue;
            }
            // Time is up.
            let why = if r.why.is_empty() { "Your limit for this app is reached.".to_string() } else { r.why.clone() };
            match st.deadline_ms {
                None => {
                    let recent = st.last_warn_ms.is_some_and(|w| now_ms - w < REOPEN_WINDOW_MS) || st.low_warned;
                    let grace = if recent { GRACE_REPEAT_SECS } else { GRACE_FIRST_SECS };
                    st.deadline_ms = Some(now_ms + grace as i64 * 1000);
                    st.last_warn_ms = Some(now_ms);
                    if mode == Mode::Close {
                        out.notices.push(Notice::Closing { slug: r.slug.clone(), label: r.label.clone(), seconds_left: grace, why });
                    } else {
                        out.notices.push(Notice::Over { slug: r.slug.clone(), label: r.label.clone(), why });
                        st.last_over_note_ms = Some(now_ms);
                    }
                }
                Some(d) if now_ms >= d => {
                    if mode == Mode::Close {
                        match st.close_sent_ms {
                            None => {
                                st.close_sent_ms = Some(now_ms);
                                out.kills.push(Kill { slug: r.slug.clone(), pids: pids.clone(), force: false });
                                out.notices.push(Notice::Closed { slug: r.slug.clone(), label: r.label.clone(), why });
                            }
                            Some(t) if now_ms - t >= FORCE_AFTER_SECS * 1000 => {
                                out.kills.push(Kill { slug: r.slug.clone(), pids: pids.clone(), force: true });
                                st.close_sent_ms = Some(now_ms);
                            }
                            Some(_) => {}
                        }
                    } else if st.last_over_note_ms.is_none_or(|t| now_ms - t >= REOPEN_WINDOW_MS) {
                        st.last_over_note_ms = Some(now_ms);
                        out.notices.push(Notice::Over { slug: r.slug.clone(), label: r.label.clone(), why });
                    }
                }
                Some(_) => {}
            }
        }
        out
    }
}

/// Which rule slugs are open right now, with the pids that belong to them.
pub fn running_by_rule(procs: &[ProcInfo], rule_slugs: &[String]) -> HashMap<String, Vec<u32>> {
    let mut by_proc: HashMap<String, Vec<u32>> = HashMap::new();
    for p in procs {
        let ids = proc_identities(p);
        if ids.iter().any(|i| is_protected(i, p.exe.as_deref())) {
            continue;
        }
        for i in ids {
            let v = by_proc.entry(i).or_default();
            if !v.contains(&p.pid) {
                v.push(p.pid);
            }
        }
    }
    let mut out: HashMap<String, Vec<u32>> = HashMap::new();
    for s in rule_slugs {
        let mut pids = Vec::new();
        for ps in process_slugs(s) {
            if let Some(v) = by_proc.get(&ps) {
                for pid in v {
                    if !pids.contains(pid) {
                        pids.push(*pid);
                    }
                }
            }
        }
        if !pids.is_empty() {
            out.insert(s.clone(), pids);
        }
    }
    out
}

// ---- service ---------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct AppsStatus {
    pub supported: bool,
    pub mode: Mode,
    pub day: String,
    /// Seconds of open time recorded today per app.
    pub usage: Vec<(String, u64)>,
    /// Rules the app refused because they target the OS, a shell, a browser or FOCUS OS itself.
    pub ignored: Vec<String>,
    pub last_scan_ms: i64,
}

pub type Sink = Arc<dyn Fn(Notice) + Send + Sync>;

pub struct AppMonitor {
    enforcer: Arc<Mutex<Enforcer>>,
    store: Arc<PersonalStore>,
    source: Arc<Mutex<Box<dyn ProcessSource>>>,
    installed: Mutex<Option<Vec<Installed>>>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

impl AppMonitor {
    pub fn new(store: Arc<PersonalStore>, source: Box<dyn ProcessSource>) -> Arc<Self> {
        Arc::new(Self {
            enforcer: Arc::new(Mutex::new(Enforcer::new())),
            store,
            source: Arc::new(Mutex::new(source)),
            installed: Mutex::new(None),
        })
    }

    pub fn list(&self) -> Vec<AppEntry> {
        let installed = {
            let mut g = self.installed.lock().unwrap_or_else(|e| e.into_inner());
            g.get_or_insert_with(scan_installed).clone()
        };
        let mut src = self.source.lock().unwrap_or_else(|e| e.into_inner());
        list_apps(&mut **src, &installed)
    }

    pub fn rescan_installed(&self) {
        *self.installed.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn push(&self, policy: AppsPolicy) -> Result<()> {
        policy.validate()?;
        let mut e = self.enforcer.lock().unwrap_or_else(|e| e.into_inner());
        let used = if e.day() != policy.day {
            Some(self.store.app_usage(&policy.day)?.into_iter().collect())
        } else {
            None
        };
        e.set_policy(policy, used);
        Ok(())
    }

    pub fn status(&self) -> AppsStatus {
        let e = self.enforcer.lock().unwrap_or_else(|e| e.into_inner());
        let mut usage: Vec<(String, u64)> = self.store.app_usage(e.day()).unwrap_or_default();
        usage.sort();
        AppsStatus { supported: true, mode: e.mode(), day: e.day().to_string(), usage, ignored: e.ignored.clone(), last_scan_ms: e.last_scan_ms }
    }

    /// One scan-and-enforce step. Public so tests can drive it with a fake clock and process source.
    pub fn step(&self, now: i64, sink: &dyn Fn(Notice)) {
        let (rule_slugs, day) = {
            let e = self.enforcer.lock().unwrap_or_else(|e| e.into_inner());
            (e.policy.rules.iter().map(|r| r.slug.clone()).collect::<Vec<_>>(), e.day().to_string())
        };
        if rule_slugs.is_empty() {
            self.enforcer.lock().unwrap_or_else(|e| e.into_inner()).last_scan_ms = now;
            return;
        }
        let mut src = self.source.lock().unwrap_or_else(|e| e.into_inner());
        let procs = src.list();
        let running = running_by_rule(&procs, &rule_slugs);
        let out = {
            let mut e = self.enforcer.lock().unwrap_or_else(|e| e.into_inner());
            e.last_scan_ms = now;
            e.tick(now, &running)
        };
        for (slug, secs) in &out.usage {
            let _ = self.store.add_app_usage(&day, slug, *secs);
        }
        for k in &out.kills {
            for pid in &k.pids {
                src.terminate(*pid, k.force);
            }
        }
        drop(src);
        for n in out.notices {
            sink(n);
        }
    }

    /// Scan and enforce forever. Run it on an async runtime and abort the task to stop it.
    pub async fn run(self: Arc<Self>, sink: Sink) {
        let mut iv = tokio::time::interval(std::time::Duration::from_secs(TICK_SECS));
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            iv.tick().await;
            let me = self.clone();
            let sink = sink.clone();
            // Process scanning is blocking work.
            let _ = tokio::task::spawn_blocking(move || me.step(now_ms(), &*sink)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(slug: &str) -> AppRule {
        AppRule { slug: slug.into(), label: display_name(slug), ..Default::default() }
    }
    fn policy(rules: Vec<AppRule>, mode: Mode) -> AppsPolicy {
        AppsPolicy { day: "2026-01-05".into(), mode, rules }
    }
    fn open(slug: &str) -> HashMap<String, Vec<u32>> {
        HashMap::from([(slug.to_string(), vec![42])])
    }

    #[test]
    fn slugs_are_stable() {
        assert_eq!(slug("Epic Games Launcher.exe"), "epic-games-launcher");
        assert_eq!(slug("Battle.net.exe"), "battle-net");
        assert_eq!(slug("Minecraft Launcher"), "minecraft-launcher");
        assert_eq!(slug("  Steam.app "), "steam");
        assert_eq!(slug("..."), "");
        assert_eq!(display_name("some-cool-game"), "Some Cool Game");
        assert_eq!(display_name("roblox"), "Roblox");
    }

    #[test]
    fn protected_things_can_never_be_limited() {
        for s in ["explorer", "finder", "chrome", "firefox", "focus-os", "systemd", "terminal", ""] {
            assert!(is_protected(s, None), "{s}");
        }
        assert!(is_protected("whatever", Some("C:\\Windows\\System32\\whatever.exe")));
        assert!(is_protected("whatever", Some("/System/Library/CoreServices/x")));
        assert!(!is_protected("roblox", Some("C:\\Users\\a\\AppData\\Local\\Roblox\\RobloxPlayerBeta.exe")));
        // A rule for a protected app is dropped when installed.
        let mut e = Enforcer::new();
        e.set_policy(policy(vec![rule("chrome"), rule("roblox")], Mode::Close), None);
        assert_eq!(e.ignored, vec!["chrome".to_string()]);
        let out = e.tick(1_000, &open("chrome"));
        assert!(out.kills.is_empty() && out.notices.is_empty());
    }

    #[test]
    fn processes_map_to_apps_including_helpers() {
        let procs = vec![
            ProcInfo { pid: 1, name: "RobloxPlayerBeta.exe".into(), exe: Some("C:\\x\\RobloxPlayerBeta.exe".into()) },
            ProcInfo { pid: 2, name: "steamwebhelper".into(), exe: Some("/home/a/.steam/steamwebhelper".into()) },
            ProcInfo { pid: 3, name: "Steam".into(), exe: Some("/Applications/Steam.app/x".into()) },
            ProcInfo { pid: 4, name: "chrome".into(), exe: Some("/opt/chrome".into()) },
            ProcInfo { pid: 5, name: "notepad".into(), exe: None },
        ];
        let m = running_by_rule(&procs, &["roblox".into(), "steam".into(), "chrome".into(), "notepad".into()]);
        assert_eq!(m.get("roblox"), Some(&vec![1]));
        let mut steam = m.get("steam").cloned().unwrap();
        steam.sort();
        assert_eq!(steam, vec![2, 3]);
        assert!(!m.contains_key("chrome"), "browsers are never matched");
        // Exact matching only: "stea" must not match "steam".
        let m2 = running_by_rule(&procs, &["stea".into()]);
        assert!(m2.is_empty());
    }

    #[test]
    fn long_names_truncated_by_the_os_still_match_through_the_executable_name() {
        let procs = vec![ProcInfo { pid: 9, name: "focus-victim-12".into(), exe: Some("/tmp/x/focus-victim-12345".into()) }];
        let m = running_by_rule(&procs, &["focus-victim-12345".into()]);
        assert_eq!(m.get("focus-victim-12345"), Some(&vec![9]));
        // and a protected executable is protected even if its name looks harmless
        let sneaky = vec![ProcInfo { pid: 1, name: "innocent".into(), exe: Some("/usr/bin/bash".into()) }];
        assert!(running_by_rule(&sneaky, &["innocent".into(), "bash".into()]).is_empty());
    }

    #[test]
    fn list_merges_running_installed_and_hides_protected() {
        struct Fake(Vec<ProcInfo>);
        impl ProcessSource for Fake {
            fn list(&mut self) -> Vec<ProcInfo> {
                self.0.clone()
            }
            fn terminate(&mut self, _: u32, _: bool) -> bool {
                false
            }
        }
        let mut f = Fake(vec![
            ProcInfo { pid: 1, name: "RobloxPlayerBeta.exe".into(), exe: Some("C:\\r\\RobloxPlayerBeta.exe".into()) },
            ProcInfo { pid: 2, name: "explorer.exe".into(), exe: Some("C:\\Windows\\explorer.exe".into()) },
            ProcInfo { pid: 3, name: "mytool".into(), exe: Some("/opt/mytool".into()) },
        ]);
        let installed = vec![
            Installed { name: "Steam".into(), slug: "steam".into(), game: true },
            Installed { name: "Roblox".into(), slug: "roblox".into(), game: false },
            Installed { name: "Terminal".into(), slug: "terminal".into(), game: false },
        ];
        let v = list_apps(&mut f, &installed);
        let by = |s: &str| v.iter().find(|a| a.slug == s);
        assert!(by("roblox").unwrap().running && by("roblox").unwrap().installed && by("roblox").unwrap().game);
        assert!(by("steam").unwrap().installed && !by("steam").unwrap().running);
        assert!(by("mytool").unwrap().running);
        assert!(by("explorer").is_none() && by("terminal").is_none());
        assert_eq!(v.iter().filter(|a| a.slug == "roblox").count(), 1, "one entry per app");
        assert!(v[0].game, "games are listed first");
    }

    #[test]
    fn desktop_entries_are_parsed() {
        let t = "[Desktop Entry]\nType=Application\nName=Steam\nExec=/usr/bin/steam %U\nCategories=Network;Game;\n";
        let i = parse_desktop_entry(t).unwrap();
        assert_eq!((i.slug.as_str(), i.name.as_str(), i.game), ("steam", "Steam", true));
        assert!(parse_desktop_entry("[Desktop Entry]\nName=X\nExec=x\nNoDisplay=true\n").is_none());
        assert_eq!(parse_desktop_entry("[Desktop Entry]\nName=Edit\nExec=env GDK_X=1 /usr/bin/gedit %f\n").unwrap().slug, "gedit");
        assert!(parse_desktop_entry("[Desktop Entry]\nType=Link\nName=Web\nURL=x\n").is_none());
    }

    #[test]
    fn open_time_is_counted_only_while_running_and_sleep_gaps_are_ignored() {
        let mut e = Enforcer::new();
        e.set_policy(policy(vec![rule("roblox")], Mode::Close), None);
        e.tick(0, &open("roblox"));
        for t in 1..=4 {
            e.tick(t * 5_000, &open("roblox"));
        }
        assert_eq!(e.used_secs("roblox"), 20);
        e.tick(25_000, &HashMap::new()); // closed: nothing added
        assert_eq!(e.used_secs("roblox"), 20);
        // Laptop slept for an hour while the app stayed "running": at most one gap's worth is counted.
        e.tick(25_000 + 3_600_000, &open("roblox"));
        assert_eq!(e.used_secs("roblox"), 50);
    }

    #[test]
    fn budget_gives_low_warning_then_grace_then_polite_close_then_force() {
        let mut e = Enforcer::new();
        let mut r = rule("roblox");
        r.budget_secs = Some(100);
        e.set_policy(policy(vec![r], Mode::Close), None);
        let mut t = 0i64;
        let mut notes = Vec::new();
        let mut kills = Vec::new();
        // Run until well past the budget, five seconds per tick.
        while t <= 300_000 {
            let o = e.tick(t, &open("roblox"));
            notes.extend(o.notices.into_iter().map(|n| (t, n)));
            kills.extend(o.kills.into_iter().map(|k| (t, k)));
            t += 5_000;
        }
        // 40 s left -> low-time warning once.
        let lows: Vec<_> = notes.iter().filter(|(_, n)| matches!(n, Notice::LowTime { .. })).collect();
        assert_eq!(lows.len(), 1);
        // Budget exhausted at ~100 s: closing notice with the short grace because a low warning was given.
        let closing = notes.iter().find_map(|(t, n)| matches!(n, Notice::Closing { .. }).then_some(*t)).unwrap();
        assert!((100_000..=110_000).contains(&closing), "{closing}");
        match notes.iter().find(|(_, n)| matches!(n, Notice::Closing { .. })).unwrap().1.clone() {
            Notice::Closing { seconds_left, .. } => assert_eq!(seconds_left, GRACE_REPEAT_SECS),
            _ => unreachable!(),
        }
        // Polite close after the grace, forced close 20 s later, never before.
        let first = kills.iter().find(|(_, k)| !k.force).map(|(t, _)| *t).unwrap();
        assert!(first >= closing + 10_000 && first <= closing + 15_000, "{first} {closing}");
        let forced = kills.iter().find(|(_, k)| k.force).map(|(t, _)| *t).unwrap();
        assert!(forced - first >= 20_000);
        assert_eq!(kills[0].1.pids, vec![42]);
    }

    #[test]
    fn a_sudden_block_gets_the_long_grace_and_close_cancels_when_the_app_is_closed() {
        let mut e = Enforcer::new();
        let mut r = rule("roblox");
        r.blocked_now = true;
        r.why = "Blocked by your class".into();
        e.set_policy(policy(vec![r], Mode::Close), None);
        let o = e.tick(0, &open("roblox"));
        assert_eq!(o.notices, vec![Notice::Closing { slug: "roblox".into(), label: "Roblox".into(), seconds_left: GRACE_FIRST_SECS, why: "Blocked by your class".into() }]);
        assert!(e.tick(30_000, &open("roblox")).kills.is_empty(), "still inside the grace period");
        // The student closes it themselves: pending close is forgotten and nothing is killed.
        assert!(e.tick(40_000, &HashMap::new()).kills.is_empty());
        // Reopening shortly after gets the short grace, not another full minute.
        let o = e.tick(50_000, &open("roblox"));
        match &o.notices[0] {
            Notice::Closing { seconds_left, .. } => assert_eq!(*seconds_left, GRACE_REPEAT_SECS),
            n => panic!("{n:?}"),
        }
        let o = e.tick(61_000, &open("roblox"));
        assert_eq!(o.kills.len(), 1);
    }

    #[test]
    fn allowed_hours_ending_closes_the_app() {
        let mut e = Enforcer::new();
        let mut r = rule("steam");
        r.allowed_until_ms = Some(120_000);
        e.set_policy(policy(vec![r], Mode::Close), None);
        assert!(e.tick(0, &open("steam")).notices.is_empty());
        let o = e.tick(65_000, &open("steam")); // 55 s left
        assert!(matches!(o.notices[0], Notice::LowTime { seconds_left: 55, .. }));
        assert!(e.tick(119_000, &open("steam")).kills.is_empty());
        let o = e.tick(125_000, &open("steam"));
        assert!(matches!(o.notices[0], Notice::Closing { .. }));
    }

    #[test]
    fn remind_mode_never_kills_and_off_mode_only_counts() {
        let mut e = Enforcer::new();
        let mut r = rule("roblox");
        r.blocked_now = true;
        e.set_policy(policy(vec![r.clone()], Mode::Remind), None);
        e.tick(0, &open("roblox"));
        let mut over = 0;
        for t in 1..200 {
            let o = e.tick(t * 5_000, &open("roblox"));
            assert!(o.kills.is_empty());
            over += o.notices.iter().filter(|n| matches!(n, Notice::Over { .. })).count();
        }
        assert!((2..=5).contains(&over), "reminders are rare, got {over}");
        let mut e = Enforcer::new();
        e.set_policy(policy(vec![r], Mode::Off), None);
        e.tick(0, &open("roblox"));
        let o = e.tick(5_000, &open("roblox"));
        assert!(o.kills.is_empty() && o.notices.is_empty());
        assert_eq!(e.used_secs("roblox"), 5, "usage is still recorded when enforcement is off");
    }

    #[test]
    fn self_reported_time_counts_and_a_new_day_resets() {
        let mut e = Enforcer::new();
        let mut r = rule("roblox");
        r.budget_secs = Some(600);
        r.extra_used_secs = 600; // already used it all, by their own account
        e.set_policy(policy(vec![r.clone()], Mode::Close), None);
        assert!(matches!(e.tick(0, &open("roblox")).notices[0], Notice::Closing { .. }));
        // Next day: usage restored from storage, budgets apply afresh.
        let mut p = policy(vec![AppRule { extra_used_secs: 0, ..r }], Mode::Close);
        p.day = "2026-01-06".into();
        e.set_policy(p, Some(HashMap::from([("roblox".to_string(), 30u64)])));
        assert_eq!(e.used_secs("roblox"), 30);
        assert!(e.tick(10_000, &open("roblox")).notices.is_empty());
    }

    #[test]
    fn invalid_policies_are_refused() {
        let mut p = policy(vec![rule("ok")], Mode::Close);
        assert!(p.validate().is_ok());
        p.day = "today".into();
        assert!(p.validate().is_err());
        assert!(policy(vec![rule("Bad Slug")], Mode::Close).validate().is_err());
        assert!(policy(vec![rule("")], Mode::Close).validate().is_err());
    }
}
