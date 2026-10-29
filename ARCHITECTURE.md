# Architecture

FOCUS OS is a local-first desktop app: **React + TypeScript** UI in a **Tauri 2** shell, with security- and
data-critical logic in a pure-Rust crate. Everything works offline. The only network use is the classroom's local
network service and a loopback bridge for a browser extension.

```
┌────────────────────────────── desktop app (Tauri 2) ──────────────────────────────┐
│ React UI (src/)                                                                    │
│  features/ ── state (zustand) ── data/ (Backend, ClassApi)  ── domain/ (pure TS)   │
│                                       │ invoke (typed commands, tauri:// origin only)│
│ ┌──────────────────────── src-tauri (thin command layer) ────────────────────────┐ │
│ │ personal.rs  classroom.rs  state.rs  error.rs   (no fs/shell/http exposed)       │ │
│ └───────────────┬──────────────────────────────────────────────────────────────────┘ │
│                 ▼                                                                    │
│  crates/focus-core (Rust, no UI, fully testable headless)                            │
│   db · crypto · policy · protocol · host · client · server · sync · discovery        │
│   personal · bridge · netinfo · ratelimit                                            │
└───────┬───────────────────────────┬─────────────────────────────┬──────────────────┘
        │ personal.db               │ classroom.db                │ 127.0.0.1:47777
        ▼                           ▼  LAN HTTP/WS (host/member)  ▼  (token)
     SQLite                      SQLite                    browser extension (MV3)
```

## 1. Layers and boundaries

| Layer | Location | Responsibility | Rule |
|---|---|---|---|
| Domain | `src/domain/*` | Time/day rules, timer state machine, spaced repetition, quizzes, planner, limits & precedence, wellness, Zod schemas | Pure functions; clock and zone are arguments; unit-tested; shared with the extension |
| Data | `src/data/*` | `Backend` (native SQLite via Tauri, or browser storage for preview/tests), `ClassApi`, store with validation, ordered writes, rollback | Never shows "saved" before the write succeeded |
| State | `src/state/*`, `src/app/ui-state.ts` | zustand stores: data, timer, environment (classes/policies/bridge), UI | No business rules; derived values are computed from state |
| Features | `src/features/*` | Screens (Today, Library, Review, Plan, Limits, Class, Settings, Onboarding) | One responsibility per file; forms mount only while open |
| Design system | `src/design/*` | Tokens, accessible primitives, Markdown renderer | See `DESIGN_SYSTEM.md` |
| Native commands | `src-tauri/src/*` | Typed Tauri commands; owns runtimes (host server, sync loops, bridge); native dialogs | Generic over `Runtime` so the real IPC path is testable on Tauri's mock runtime |
| Core | `crates/focus-core` | Authority logic, crypto, protocol, SQLite, networking | Security decisions live **here**, never in the UI |
| Extension | `extension/` | Measures foreground time on configured sites, enforces blocks | Reuses `src/domain/{time,limits}`; talks only to the loopback bridge |

Dependencies point downward only. Domain code imports nothing from React, Tauri or storage.

## 2. Data and storage

**Two separate SQLite files** in the app data directory (owner-only permissions on Unix):

* `personal.db` — private study data. Migrations in `crates/focus-core/migrations/personal_*.sql`:
  `documents(collection, id, json, updated_at)` with `json_valid` check, and `measured_usage(day, platform, source, seconds)`.
  Documents are JSON validated by Zod in the UI and by size/shape/ids in Rust. Writes are atomic batches.
  Backups use `VACUUM INTO` and are re-opened and integrity-checked before being reported as successful.
* `classroom.db` — `classes`, `members` (with the one-active-admin unique index), `devices`, `pairing_sessions`,
  `policy_revisions`, `audit_events` (hash-chained), `seen_nonces`, `memberships`, `client_policies`.

Why a generic document table for personal data: the UI already validates every collection with versioned Zod
schemas; a relational schema for ~16 small collections would duplicate that without a query benefit at student scale
(everything is loaded in memory and searched there). Trade-off: no SQL-level foreign keys or FTS for personal data.
It is isolated behind the `Backend` interface if that ever needs to change.

Migrations are versioned and transactional; a database written by a **newer** version is refused rather than
downgraded (`database schema vN is newer…`). Corrupt or newer-shaped *documents* are quarantined (listed in
Settings, left untouched), never deleted or crashing the app.

Browser preview (`npm run dev` in a plain browser) uses `localStorage` through the same `Backend` interface. It
exists for development and UI tests, is labelled as such in the UI, and is **not** the shipped storage.

## 3. Algorithms (specified, deterministic, tested)

### Days
A *study day* is `YYYY-MM-DD` in the student's IANA zone, shifted by a **reset hour** (default 04:00) so a 01:00
session belongs to the day it started. Day boundaries are computed with `Intl` so DST is handled by the platform's
tz database (tested across DST changes, including a 25-hour day).

### Focus timer (`domain/timer.ts`)
State = a list of **active segments** + a heartbeat (last instant the app knew it was alive). A tick every second
advances it and persists every 5 s. If the next tick arrives later than **150 s** after the heartbeat (sleep, closed
app, crash) the gap is **not counted**: the timer stops at the heartbeat and becomes *paused (interrupted)* for the
student to resume or end. A backwards clock jump counts nothing negative and loses nothing already counted. On
restart the persisted timer is recovered the same way and the UI says what happened. Completion never completes a
task; "End" writes an immutable session, adds the minutes to the linked task's *actual* time, and clips minutes to
study days across midnight. An active timer is never treated as proof of attention.

### Spaced repetition (`domain/srs.ts`) — SM-2 family, no randomness
Grades *again/hard/good/easy*; states *new → learning → review* (a lapse goes *review → relearning → review*).

| State | again | hard | good | easy |
|---|---|---|---|---|
| new / learning / relearning | due today | 1 day | 1 day, then 3 days | 4 days (graduates) |
| review (interval *i*, ease *e*) | lapse: interval 1, ease −0.20 (≥ 1.3), relearning | max(i+1, round(1.2 i)), ease −0.15 | max(i+1, round(base·e)) | max(i+2, round(base·e·1.3)), ease +0.15 |

`base = i + min(⌊overdue/2⌋, i)`: recalling a card late earns bounded extra credit. **Being late never changes
ease and never causes a lapse.** Intervals cap at 365 days. The daily queue is most-overdue first, then new cards,
capped by "new per day" and "max reviews"; leftovers are reported as *backlog*, never forced. Every answer is
persisted atomically with its review-log entry and can be undone.

### Quizzes (`domain/quiz.ts`)
Multiple choice and short answer. Short answers are normalised (case, whitespace, edge punctuation) and numbers
compare by value; **one typo on an answer of ≥ 5 characters returns *close* and the student decides** — near
misses are never silently accepted or rejected. Mistakes are the questions whose *latest* attempt was not correct;
"understanding" is the share currently correct among attempted questions (null with no attempts). Mistakes become
flashcards only when the student asks, and are de-duplicated.

### Planner (`domain/planner.ts`)
Everything here *proposes*. `suggestNext` ranks open tasks by deadline pressure, planned-for-today, priority and
nearby exams, and returns plain-language **reasons**, not scores. `remainingMin` = estimate − actual, or a 15-minute
buffer once the student has overrun (the UI then offers "add 20 min" or a day with room). `suggestDay`/`proposeCatchUp`
find the earliest day with capacity before the deadline, flag *tight* plans and past-deadline work, and never move
anything without confirmation. `examPlan` spreads a first pass early and quick reviews close to the exam within
capacity. `estimateAccuracy` (median actual/estimate, needs ≥ 4 finished tasks) offers an adjusted estimate. There is
no productivity score or grade anywhere.

### Limits and precedence (`domain/limits.ts`)
1. Application integrity (nothing can disable the app's own safeguards).
2. **Class rules** — the strictest rule per platform across all joined classes; a block beats everything.
3. **Personal rules** — only if *every* joined class allows them, and they can only **tighten** (min budget,
   intersection of allowed hours).
4. App defaults (no restriction).
Every rule carries its origin. Usage is two separate numbers: **measured** (from the extension) and
**self-reported** (typed by the student); both are shown, neither is invented. Status is *derived*: enforcement is
`enforced_in_browser` only if the extension has contacted the bridge in the last two minutes; otherwise rules are
shown as "configured, not enforced" with the reason (never connected / silent / bridge down / browser preview).
Apps outside the browser are covered only by the native app monitor below, and only when it is on.

### Apps (`domain/apps.ts`, `crates/focus-core/src/apps.rs`)
An app rule is an ordinary limit rule whose platform id is `app.<slug>` (slug = lower-case hyphenated process/app
name, identical in TS and Rust, tested on both sides). It therefore travels through class policy (schema v1 unchanged;
ids fit the existing platform alphabet), precedence and storage like any website rule. The frontend computes the
*effective* app rules and pushes `{day, mode, rules[{slug, blocked_now, why, budget_secs, extra_used_secs,
allowed_until_ms}]}` to the native monitor every 30 s and on any change; the monitor needs no clock zone or calendar
logic of its own. Every 5 s it lists processes (`sysinfo`), maps them to rule slugs by exact name (+ aliases), adds
elapsed seconds (capped at 30 s per tick, so sleep is not counted) to `app_usage` in `personal.db`, and runs the pure
`Enforcer`: *low-time notice at ≤ 60 s left → grace → polite close → forced close after 20 s*. Modes: `close`,
`remind` (never kills), `off` (counts only). Protected processes (OS, shells, browsers, FOCUS OS) are filtered out
both from the list and from enforcement. Notices go to the window (`focus://apps-notice` event) and to the OS
notification centre. Honest status: the Apps screen says "Watching this computer" only when the native monitor
answers and the mode is not `off`.

### Wellness (`domain/wellness.ts`)
Reminders count only *running focus time*, start a full interval after the first observed focus second, honour quiet
hours (including overnight spans and the student's zone), snoozing and delivery (in-app / system / off), and persist
their anchors so a restart cannot cause a burst.

## 4. Classroom architecture
Documented in `NETWORK_PROTOCOL.md` (wire format, handshake, invariants) and `SECURITY.md` (threat model, evidence).
In short: the admin's computer runs `HostService` + an axum HTTP/WebSocket server bound to one LAN interface;
members run `ClassSync` (reconnecting WebSocket + signed HTTP); both keep SQLite state and the host is a
*temporary authority*, not a cloud service. All authority checks are in `HostService`; the HTTP layer is a thin wrapper.

## 5. Browser extension (`extension/`)
MV3 service worker. Every 30 s (and on tab/window focus changes) it observes the focused tab, window focus and idle
state, credits whole seconds (capped at 45 s per interval, to the study day in which the interval began) to the
matching platform, uploads deltas to the loopback bridge (retaining and merging any that fail), fetches the current
rules, and enforces them with `declarativeNetRequest` redirects plus moving tabs that are already open. The pure
logic (`tracker.ts`) shares `isAvailableAt`/`dayKey` with the app so both sides agree on windows and day boundaries.
Pairing is manual: the user pastes the bridge address and token (shown in Limits) into the extension's options.

## 6. Decisions worth remembering
* **Phase order.** The classroom core (Phases 7–8) was built and verified *first*, because it was the highest
  technical risk and everything else could be tested around it. UI phases followed the same dependency order as the brief.
* **No relational schema for personal data** (see §2) and **no mandatory dependency on any cloud, AI or paid service.**
* **Optional AI** was not implemented: it would add a network dependency and a trust problem (unverified generated
  questions) for little benefit versus authored material. The learning engine is complete without it.
* **Remotion / Hyperframes / FFmpeg** were evaluated and not used: the first-run intro is a native SVG/CSS/Motion
  sequence (< 3 s, skippable); a rendered video would add weight and (for Remotion) a custom license without
  improving it. FFmpeg was only used as a local screen-capture helper during verification, not shipped.
* **Dialogs mount only while open**, so form state starts fresh each time (no effects that reset state) — also what
  the React compiler lint rules require.
