# Project status

_Last verified: final verification run on Linux (see `TESTING.md` for commands and exact results)._

**One-line summary:** a working, tested, local-first desktop study environment with a real serverless classroom and a
real browser extension, verified on Linux. Windows/macOS packaging, human screen-reader testing and multi-computer
Wi-Fi trials are **not** done.

## What genuinely works (verified)

| Area | Status | Evidence |
|---|---|---|
| App shell, navigation, command palette, shortcuts, themes, reduced motion | ✅ works | Playwright (28), vitest flows, native e2e |
| First-run experience (skippable, once only) | ✅ | Playwright + vitest |
| Focus timer (start/pause/resume/extend/end, history, task time) | ✅ | 18 timer tests, store tests, native e2e (persisted to SQLite) |
| Timer reliability: sleep gap excluded, restart recovery, clock jumps, midnight/DST | ✅ (simulated clock) | unit tests; recovery also seen after real app restart in native e2e |
| Subjects/topics, notes (autosave, status, soft delete + undo), search, export/import/backup/restore | ✅ | vitest flows, store tests, Rust `personal` + IPC tests |
| Flashcards + deterministic spaced repetition, undo, daily caps | ✅ | 17 SRS tests + flows |
| Quizzes (MC/short), mistakes, mistakes→cards on request | ✅ | quiz tests + flows |
| Planner: tasks, priorities, estimate vs actual, overrun advice, catch-up proposals, week workload, exams, revision plans, weekly review | ✅ | 17 planner tests + flows |
| Limits: budgets, hours, weekdays, warnings, pause, class+personal precedence, measured vs self-reported, derived enforcement status | ✅ | 17 limits tests + flows |
| Browser extension (measure foreground time, upload, block/unblock) | ✅ real Chromium | `extension.e2e.mjs` 12/12 |
| **Apps**: list apps/games, personal and class app rules, open-time measurement, warn → polite close → forced close, protected programs, Remind/Off modes | ✅ on Linux (real processes); ⚠️ Windows/macOS untested | `apps.rs` unit tests, `tests/apps.rs`, IPC test, 8 UI tests, native e2e closes a real program through the UI |
| Ambient depth: sparkles, CSS-3D gyro and cube, switchable | ✅ | Playwright (decorative, no overflow, click-through, switch, reduced motion) |
| Wellness reminders, quiet hours, breaks | ✅ logic + in-app delivery | 9 tests; system-notification delivery **unobserved** |
| Classroom: create offline, pair (QR/code/manual), join, signed live policy sync, ack tracking, removal, audit, rotate/export/transfer/recovery, re-discovery | ✅ | 26 Rust tests + IPC lifecycle + native e2e with independent Node device |
| Data safety: transactional writes, rollback on failure, quarantine of unreadable data, verified backups, schema-downgrade refusal | ✅ | store/personal/IPC tests |
| Security controls (see `SECURITY.md`), incl. remote origins cannot call commands | ✅ | IPC ACL test, protocol tests |
| Accessibility (automated): 0 axe violations on 7 screens × 2 themes, focus trap/return, no overflow at 760 px | ✅ | Playwright |
| Packaging | 🟡 Linux `.deb` builds (7.2 MiB, release profile); package contents inspected, but it was **not installed or launched** from the package. The app icon in it is still a flat placeholder. | `tauri build --bundles deb` |

## What is partial
* **Enforcement**: websites in Chromium browsers (extension) and desktop apps/games (native monitor: counts open time,
  warns, then closes). Phone apps are not covered. The app monitor is verified on Linux with real processes only.
* **Notifications**: in-app delivery works; the OS notification plugin is wired but its delivery wasn't observed.
* **Classroom on real networks**: protocol and recovery paths verified with real sockets on one machine; router/firewall/
  client-isolation behaviour is documented but untested.
* **Accessibility**: automated only.

## What is not implemented (by decision or not yet)
Optional AI helpers; family/guardian views and a teacher role; images/audio in notes and cards; TLS for the classroom
channel; OS-keychain storage for device keys; Firefox/Safari extensions; Windows/macOS builds;
code signing/auto-update; localisation. See `KNOWN_LIMITATIONS.md` (with roadmap).

## Defects found and fixed during verification (each with a regression test)
* Overdue task reported "before its deadline" by the day suggestion (`planner.test`).
* Weekly review assigned completions to UTC days instead of the student's day (`planner.test`).
* Clock-jump handling in the timer discarded counted time (`timer.test`).
* A failed hosting start after `class_create` left an orphan class and invited a duplicate (`ipc::class_creation_rejects_weak_input`).
* Invite countdown overstated validity ("11 min" for a 10-minute invite) (`classroom.test::remainingText`).
* Quiz near-miss answers kept asking after "No" (`flows.test` near-miss tests).
* Sticky header could cover keyboard focus / scrolled targets (`scroll-padding`; Playwright "scroll-padding" test).

## Open items / next highest-value task
1. Build and run on Windows and macOS (CI matrix), then fix whatever that reveals.
2. TLS with a pinned certificate in the join code; keychain-backed device keys.
3. A real-classroom trial on two physical computers over typical school Wi-Fi.
4. Human screen-reader and keyboard-only usability pass.

## Checklist
- [x] Repository audit (empty start), architecture and risk assessment
- [x] Design system + shell + first-run
- [x] Local data foundation (SQLite, migrations, backups)
- [x] Focus system · [x] Learning engine · [x] Planner · [x] Limits + extension
- [x] Serverless classroom foundation · [x] Live policy sync + recovery · [x] Class policy integration
- [x] Wellness · [x] Refinement (a11y, layout, motion) · [~] Release readiness (Linux only)
- [ ] Windows/macOS verification · [ ] Real multi-device trial · [ ] Human a11y testing
