# FOCUS OS

A calm, local-first desktop study environment: focus timer, notes, flashcards with spaced repetition, quizzes, a
realistic homework/exam planner, honest distraction limits for websites **and desktop apps/games**, and a **serverless classroom** where the teacher's
computer temporarily hosts the class over the local network. No account, no cloud, no telemetry, works offline.

* React + TypeScript (strict) · Vite · Tauri 2 · Rust · SQLite
* Read `PROJECT_STATUS.md` first for what works, what is verified and what is not.

## Documentation
| File | Contents |
|---|---|
| `PROJECT_STATUS.md` | Verified features, partial/unimplemented, fixed defects, next task |
| `ARCHITECTURE.md` | Layers, storage, the exact algorithms, extension, decisions |
| `NETWORK_PROTOCOL.md` | Classroom wire protocol v1 (enough to write an independent client) |
| `SECURITY.md` | Threat model, controls with evidence, what is *not* protected |
| `TESTING.md` | How to run everything, results, real-vs-simulated, unverified items |
| `KNOWN_LIMITATIONS.md` | Honest limits + prioritised roadmap |
| `DESIGN_SYSTEM.md` | Visual language, tokens, components, motion, accessibility |
| `IMPLEMENTATION_PLAN.md` | Phases and milestones |

## Build and run

Prerequisites: Node 22+, Rust (stable, 2024 edition), and for Tauri on Linux
`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev build-essential pkg-config`
(Windows: WebView2 + MSVC build tools; macOS: Xcode command-line tools — **not verified**, see `TESTING.md`).

```bash
npm ci
npm run tauri dev        # desktop app with hot reload
```

Browser-only preview (no classroom, no native storage — development and UI tests):

```bash
npm run dev              # http://127.0.0.1:1420
```

Release build:

```bash
npm run tauri build      # produces the installer/bundle for the current OS under target/release/bundle
```

Install the Linux package produced by `tauri build --bundles deb` with `sudo apt install ./target/release/bundle/deb/*.deb`.
Running a classroom host on Linux/Windows/macOS may trigger a firewall prompt for *private networks*; allow it. FOCUS OS
never changes firewall or system settings itself.

## Browser extension (optional, for measuring and blocking websites)

```bash
npm run build:extension          # outputs extension/dist
```

1. Chrome/Edge → `chrome://extensions` → Developer mode → **Load unpacked** → choose `extension/dist`.
2. In FOCUS OS open **Limits → Connect the browser extension**, copy the address and token.
3. Paste them in the extension's options page and press **Connect**. Limits now show *Enforced in browser*.
Without the extension, limits are saved but shown as **Not enforced** — the app never pretends otherwise.

## Limiting apps and games
Open **Apps** (key `6`). It lists what is running or installed on this computer (games first). Pick one, choose a daily
budget and/or allowed hours; FOCUS OS counts how long the app is **open**, warns you, then closes it. If you joined a
class, rules the teacher publishes for apps appear here automatically (the teacher adds them under **Class → Rules →
App and game rules**). *Remind only* and *Off* are one click away and the screen always says what is not enforced.
The operating system, terminals and browsers are never touched. See `KNOWN_LIMITATIONS.md` for what this cannot do.

## Classroom quick start
* **Teacher:** Class → *Create a class* (choose your Wi-Fi interface and an administrator passphrase) → *Save a recovery
  bundle* → *Create invite*, show the QR/code.
* **Student:** Class → *Join a class* → paste the code, choose a display name. Students must be on the **same network**;
  guest Wi-Fi often blocks this (the app explains and offers manual `ip:port`).
* The teacher's app must stay open to push changes. If it closes, students keep their last rules and see "host unreachable".

## Backup and recovery
* **Your study data:** Settings → *Back up now* (verified copies, newest 20 kept in the app data folder), *Export
  everything* (plain JSON you own), *Import*, *Restore* (takes a safety copy first). Unreadable items are listed and never deleted.
* **A class:** Class → *Save recovery bundle* (encrypted `.fosrecovery`). Lost host: another computer uses *Take over a
  class* with the bundle and its passphrase. **Without a bundle, a lost host's class cannot be recovered.**
* Data location (Tauri `app_data_dir`): Linux `~/.local/share/app.focusos.desktop/`, macOS `~/Library/Application Support/app.focusos.desktop/`,
  Windows `%APPDATA%\app.focusos.desktop\`. Files: `personal.db`, `classroom.db`, `bridge.token`, `backups/`.

## Test everything
See `TESTING.md`. In short: `npm run typecheck && npm run lint && npm test && npm run build && cargo test --workspace && npx playwright test`.

## Layout
```
src/            React UI (domain/ pure logic · data/ · state/ · features/ · design/)
crates/focus-core/   Rust: crypto, SQLite, protocol, host/client, discovery, bridge (+ tests, migrations)
src-tauri/      Tauri shell (typed commands, no fs/shell/http exposed) + IPC tests
extension/      MV3 browser extension (TypeScript, shares domain code)
tests-e2e/      Playwright (browser), extension e2e, native e2e (tauri-driver)
```
