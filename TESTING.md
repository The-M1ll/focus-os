# Testing

Everything below was run in the build environment (Linux x86-64, Ubuntu 24.04 container, Node 22, Rust 1.97).
Numbers are from the final verification run. Nothing is claimed that was not executed.

## How to run

```bash
npm ci
npm run typecheck            # tsc --noEmit (strict)
npm run lint                 # eslint incl. react-hooks / React Compiler rules
npm test                     # vitest: domain, data, state, UI flows, extension logic
npm run build                # frontend bundle (also required once before the Tauri tests, see below)
cargo clippy --workspace --all-targets
cargo test --workspace                       # Rust: core, bridge, IPC; needs `npm run build` first
cargo test --workspace -- --include-ignored  # + the two tests that need multicast
npx playwright test                          # real Chromium: workflows, layout, axe-core a11y (browser preview)
npm run test:ext-e2e                         # real Chromium + unpacked extension + real Rust bridge (Xvfb)
npm run build && cargo build -p focus-os --features custom-protocol && \
  xvfb-run -a node tests-e2e/native.e2e.mjs  # the real desktop app driven through its UI (needs tauri-driver, WebKitWebDriver)
```

`src-tauri/tests/ipc.rs` embeds the real `tauri.conf.json`/capabilities via `generate_context!`, which needs `dist/`
to exist, hence `npm run build` first. Playwright uses `CHROMIUM_PATH` (default `/opt/pw-browsers/chromium`).

## Results (final run)

| Suite | Result | What it proves |
|---|---|---|
| `tsc --noEmit`, `eslint .`, `cargo clippy --workspace --all-targets` | clean | strict types, hooks/compiler rules, no Rust lints |
| `vitest` | **194 / 194** in 16 files | see below (+14 apps domain, +8 Apps UI) |
| `cargo test --workspace -- --include-ignored` | **71 / 71** (69 default + 2 multicast) | core, apps monitor (12 unit + 4 real-process), bridge, IPC (8), discovery |
| `playwright test` | **33 / 33** | workflows, no horizontal overflow at 1280/900/760 px on 8 screens, **axe-core: 0 violations on all 8 screens × dark/light**, ambient effects (decorative, click-through, switch, reduced motion), focus trap + focus return, sticky-header scroll-padding, reduced motion, axe harness self-check |
| `extension.e2e.mjs` | **12 / 12** | real Chromium + extension + real bridge: auth, measured time, no time for background tabs, block/unblock, honest failure |
| `native.e2e.mjs` | **37 / 37** | real desktop app (WebKitGTK) through its UI + an independent Node device speaking the documented protocol + **a real program is listed, warned about and closed through the Apps screen** |
| `npm audit` / `cargo audit` | 0 vulnerabilities / 0 vulnerabilities (+5 informational, see SECURITY.md) | |

### Unit and component tests (vitest, 194)
* **time (11)**: zones, reset hour, DST (incl. 25-hour day), day arithmetic, week starts, validation.
* **timer (18)**: pause/resume, completion trimming, **sleep gap not counted**, throttling tolerance, backwards clock,
  restart recovery, JSON round-trip, finalisation, **midnight and DST splitting**.
* **srs (17)**: every grade/state transition, ease floor, interval cap, **late reviews not penalised**, determinism,
  queue caps/backlog, retention summary.
* **quiz (11)**, **planner (17)**, **limits (17)** incl. precedence cases, **wellness (9)**, **extension tracker (12)**.
* **data store / backend / timer store (13)**: optimistic write with **rollback on failure**, schema quarantine of
  corrupt documents (kept in storage), atomic batches, export/import validation, restore takes a safety copy, timer
  persistence and recovery, accidental starts not logged.
* **autosave (5), Markdown (4)**: debounce, in-flight edits not lost, flush on unmount, failure + retry; no raw HTML/`javascript:`.
* **Apps (14 domain + 8 UI)**: slug parity with Rust, availability windows in the student's zone, class block / strictest budget / hours precedence reflected in the policy pushed to the monitor, switched-off rules send nothing, extension never receives app rules; UI: preview honesty, desktop list (games first, filter), class rule appears automatically and is pushed as blocked, personal rule cannot loosen it, Off mode is honest everywhere, warnings shown, class editor publishes `app.<slug>`.
* **App flows (24, jsdom, whole app against an in-memory backend)**: first-run, timer start/pause/end without completing
  the task, interruption recovery, keyboard + palette, task validation and undo, overrun advice, catch-up proposals
  (not applied until confirmed), exam plan (not added until confirmed), note autosave surviving reload, subject delete
  confirmation listing exactly what is lost, flashcard review + undo, quiz → mistakes → flashcards only on request, near-miss short answers ("No" counts as a mistake and stops asking; "Yes" counts as correct),
  Limits in preview ("not enforced", measured vs self-reported kept apart), settings: delete-all needs `DELETE` and takes
  a backup, backup/restore round-trip, unreadable items reported not deleted.
* **Class UI (14, fake `ClassApi`)**: no desktop app → disabled; admin hosting status, per-member sync state ("on
  revision 1 of 2" is not "synced"), host stopped, invite QR/code/expiry (countdown never overstates validity),
  removal confirmation, policy editor validation + exact published payload, handover warning; member view with provenance,
  **host-unreachable wording ("last policy stays in force", never "Live")**, sync-now, live status updates.

### Rust (54)
* **crypto (4), policy (4), ratelimit (1), netinfo (1)** unit tests.
* **`host_logic` (16)** — authority layer with an injected clock: one-active-admin DB constraint, join + mutual
  verification, wrong-proof lockout, expiry and use limits, replay, non-admin cannot create invites or publish, unchanged
  payload does not bump the revision, locked host cannot publish, unlock lockout with backoff, stale/forged/wrong-class/
  unsupported-schema policies, removal, audit-chain tamper detection, **transfer** and **recovery** (single admin kept,
  old admin demoted/revoked, restoring twice refused), newer-schema database refused.
* **`network` (10)** — **separate databases and real TCP/WebSocket on loopback** (see caveat): class created offline,
  two clients receive and persist a policy, host sees acknowledgements and online state; unauthorised, unsigned,
  stranger-key and tampered requests refused; replayed request refused; failed joins persist nothing; **missed updates
  recovered after reconnect and across a client restart**; **host restart** (offline state, policy kept, re-unlock,
  reconnect, catch-up); removal cuts off and notifies; malformed/oversized input rejected without state change;
  impostor host's policy rejected; 8 concurrent joins on a 3-use invite → exactly 3.
* **`personal` (6)**: CRUD, atomic batch, name/size validation, export/import validation, verified backups, reopen.
* **`bridge` (3)**: loopback only, token required, usage accumulation, invalid reports refused.
* **`discovery` (2, multicast)**: advertise/browse; **member re-discovers a host whose address changed**.
* **`ipc` (7)** — the real Tauri commands over the real IPC path (Tauri mock runtime + the app's real
  context/ACL), two app instances: store round-trip/backup/restore/validation/restart, bridge status,
  weak class input refused (and no orphan class), invalid join codes, **full classroom lifecycle through the command
  layer**, and **remote web content cannot call any command**.

## Known flake
`extension.e2e.mjs` measures real seconds of foreground time; on one run immediately after the full Playwright suite it
reported 10/12 and then passed 12/12 on three consecutive reruns. The cause was not isolated (timing under CPU load is the
likely one); if it fails, rerun it alone before investigating.

## Real vs simulated — be precise
* **Real:** sockets (TCP, WebSocket, mDNS multicast), SQLite on disk, Ed25519/HMAC/Argon2id, Chromium with the
  extension, the Tauri/WebKitGTK app and its IPC.
* **Simulated / limited:**
  * The `network` tests and the IPC lifecycle run **multiple instances in one process on one machine** (loopback or
    the container's LAN address). They do **not** test a router, client isolation, firewalls, Wi-Fi roaming or two
    physical computers. The native e2e adds a second *independent implementation* on the same machine.
  * The `class` UI tests use a fake `ClassApi`; the real API is covered by the IPC and native tests.
  * `playwright test` runs the **browser-preview** backend (localStorage); the native storage path is covered by the Rust
    tests, the IPC tests and the native e2e.
  * Timer sleep/resume is tested by feeding the state machine timestamps, not by suspending a real machine.
  * Load/limit behaviour (256 WebSocket connections, rate limits at their thresholds, 64 MiB KDF timing on slow
    hardware) is **not** measured.

## CI
`.github/workflows/ci.yml` runs the same commands on GitHub Actions (web checks, Rust + clippy + cargo-audit, Playwright,
and a three-OS build matrix). **It has never been executed** by the author; treat its first run as the first Windows/macOS
verification and expect to fix things.

## Not verified in this environment (do before release)
* Windows and macOS: build, packaging (`.msi`/`.exe`, `.app`/`.dmg`), notifications, firewall prompts, mDNS behaviour,
  WebView2/WKWebView rendering, and the extension on Edge/Chrome there.
* Real multi-device classrooms on typical school Wi-Fi (client isolation, captive portals).
* Screen readers (NVDA, VoiceOver, Orca): automated axe-core checks pass but a human screen-reader pass has not been done.
* Low-end hardware performance and battery impact; Argon2id (64 MiB) unlock time on a slow laptop.
* System notifications on any OS (the plugin is wired; delivery was not observed).
