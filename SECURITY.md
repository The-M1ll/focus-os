# Security and privacy model

This file describes what FOCUS OS protects, how, what it does **not** protect, and the evidence for each claim.
"Verified" means a test in this repository exercises it and passed in the build environment (Linux).

## 1. Assets and what is shared

| Asset | Where it lives | Leaves the computer? |
|---|---|---|
| Notes, flashcards, quizzes, tasks, exams, focus sessions, usage, settings | `personal.db` (SQLite, local) | **Never.** Not in any protocol, not in class traffic, no telemetry. |
| Class signing key (host) | `classroom.db`, sealed with the administrator passphrase | Only inside an encrypted recovery bundle the administrator creates |
| Device keys, pinned class key | `classroom.db` | Public halves only |
| Class policy (rules, goals) | host and members | LAN, between class devices only |
| Display name, online state, acknowledged revision | host sees them | LAN only |
| Extension bridge token | `bridge.token` (0600) | Never; pasted by the user into the extension |

There is no analytics, crash reporting, account system, cloud sync or AI/network service of any kind. By
construction: the source contains no outbound internet calls (the only sockets are the classroom host/client on the
LAN and the loopback extension bridge) and the webview CSP is `default-src 'self'; … connect-src 'self' ipc:`.
This has been reviewed in code but **not** verified with a packet capture.

Never collected: keystrokes, screenshots, camera, microphone, file contents, browsing history (the extension
reports only seconds per *configured platform per day*; URLs are matched locally and not stored or sent).

## 2. Threat model

**In scope.** The local network may contain untrusted devices (students, neighbours, a guest on the Wi-Fi). A
student may try to join without permission, forge or replay class rules, impersonate the administrator, change the
policy, read other students' data, or crash the host with malformed input. Web content must never reach native
commands. A lost or stolen laptop must not expose notes more than the OS already does.

**Out of scope / cannot be defended.** A student who fully controls their own computer (OS account, files,
network) can remove the extension, edit the local database, change the clock or block the host. Class rules are
*coordination* and honest status, not a lock. See `KNOWN_LIMITATIONS.md`.

## 3. Controls and verification

### Pairing and authorization (classroom)
| Control | Evidence |
|---|---|
| Joining needs a 128-bit one-time secret that never crosses the network (HMAC proof) | `host_logic::wrong_pairing_proof_is_rejected_and_pairing_locks_after_five_failures`, native e2e |
| Invite expiry (≤ 15 min), use limit enforced atomically, 5 wrong proofs burn the invite | `pairing_expires_and_respects_max_uses`, `connection_survives_many_concurrent_joins_without_exceeding_max_uses` (8 concurrent joins, limit 3 → exactly 3) |
| Mutual authentication: client rejects a host that cannot prove the secret or presents another class key | `join_succeeds_and_client_verifies_host` |
| Join and request replay refused (persisted nonces) | `join_replay_and_duplicate_device_rejected`, `replayed_signed_request_is_rejected`, native e2e |
| Every request signed by a device key over method, path, timestamp, nonce, body hash; tampered body refused | `unauthorized_clients_cannot_change_policy_or_list_members` |
| Authority comes from the database, never from client claims; members cannot publish, list members, or create invites | same test; `ipc::classroom_end_to_end…`; native e2e (403s) |
| Exactly one active administrator, enforced by a partial unique index | `exactly_one_active_admin_enforced_by_database`, restore tests |
| Policies are signed by the class key; clients accept only the pinned key, only increasing revisions, only valid schema | `client_applies_in_order_and_rejects_stale_forged_and_wrong_class`, `client_ignores_policy_from_impostor_host`, `client_reports_unsupported_schema_distinctly`, native e2e (Node verifies Rust signatures; tampering fails) |
| Input limits: body 16 KiB, WebSocket frame 64 KiB, ≤ 64 rules, unknown fields rejected, 256 WS connections | `malformed_and_oversized_input_is_rejected_without_state_change` (the 256-connection cap and rate limits are implemented but **not** load-tested) |
| Rate limits: joins per IP, requests per device, unlock backoff | `ratelimit` unit test; `unlock_lockout_with_exponential_backoff` (per-IP/per-device limits are implemented but not integration-tested at their thresholds) |
| Hash-chained audit log | `audit_chain_detects_tampering` |
| Host never listens on all interfaces or loopback | native e2e (loopback connection refused) |

### Key and secret storage
* **Class key:** Argon2id (64 MiB, t = 3) + ChaCha20-Poly1305, passphrase ≥ 10 characters. Wrong passphrase, wrong
  AAD and hostile KDF parameters are tested (`crypto` unit tests). Native e2e confirms the stored blob is sealed.
* **Device keys / pinned keys:** stored unencrypted in `classroom.db` with owner-only file permissions (0600 on
  Unix; verified). They are per class, so one class cannot correlate you with another. **OS keychain integration
  (Windows DPAPI/Credential Manager, macOS Keychain) is not implemented**; an attacker who can read your user
  files can impersonate your device in that class (and nothing more: it carries no study data).
* **Bridge token:** 256-bit, `bridge.token` 0600, compared in constant time.
* Secrets are zeroized where the crates allow it; error messages and logs never include passphrases, tokens,
  pairing secrets, keys or note text (`error.rs`; logging is `warn` level by default).

### Application surface (Tauri)
* Capabilities are minimal: `core:default` and `notification:default`. **No `fs`, `shell`, `http` or `opener`
  plugin is exposed to the webview.** Our own commands never take a filesystem path from JavaScript: file dialogs
  are opened natively in Rust and backups are restored by *name* from the app's own folder.
* **Remote content cannot call native commands** — verified: `ipc::remote_web_content_cannot_reach_any_command`
  invokes six commands from an `https://` origin and each is refused by Tauri's ACL.
* CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
  font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost` (`'unsafe-inline'` for styles only, because
  components set inline style attributes). No remote fonts, scripts or images are loaded.
* All SQL is parameterised. Collection and document ids are validated (`[A-Za-z0-9_.:-]{1,64}`); documents must be
  valid JSON ≤ 2 MiB; batches ≤ 500 operations and atomic. Imports are validated in full before any change.
* The markdown renderer produces React elements only (no raw HTML) and links are limited to `http(s)`/`mailto`
  (`Markdown.test.tsx` feeds `<script>`, `onerror` and `javascript:` payloads).

### Extension bridge
* Binds **127.0.0.1 only**, bearer token on every data route, no CORS headers (web pages cannot read responses or
  pass a preflight), 4 KiB bodies, usage reports validated (`YYYY-MM-DD`, platform id, ≤ 3600 s per report).
* The extension refuses non-loopback bridge addresses and holds only the host permissions needed (the six built-in
  platforms and `127.0.0.1:47777`; others are optional).
* Verified by `tests/bridge.rs` and the real-Chromium extension e2e (wrong token is rejected and reported).

### Closing apps (Apps section)
* **A class cannot run anything on a student's computer.** A policy can only *name* an app (`app.<slug>`, validated
  against `[a-z0-9.-]{1,64}` by the host and by every client); the student's own app decides whether anything matches,
  and the only action it can take is asking a matching process to quit. There is no command, path or argument in the
  protocol.
* **Consent and visibility:** rules come from a class the student chose to join; every rule shows its origin, every
  action is preceded by a notification, the student can set *Remind only* or *Off* at any time (and the screen then
  says "Not enforced"), and nothing about app use is sent to the class.
* **Blast radius is bounded:** operating-system processes, shells/terminals, browsers and FOCUS OS itself can never be
  limited or closed (exact-name list plus system path prefixes), enforced both when listing and when acting; matching
  is by exact process name, never by substring.
* Verified by `focus_core::apps` unit tests, `tests/apps.rs` (a real process is warned about, really ended, and not
  ended in remind mode; protected names are ignored) and the native e2e (a real program is closed through the UI).

### Dependencies
* `npm audit`: 0 vulnerabilities (runtime and dev). `cargo audit` (RustSec database as of the run): **0
  vulnerabilities**, 5 informational warnings, all transitive and Linux-only (`proc-macro-error`, `zbus_names`,
  `zvariant`, `zvariant_derive` unmaintained; `glib 0.18` unsound `VariantStrIter`) pulled in by Tauri's GTK /
  notification stack. We do not call the affected `glib` API. Revisit on every Tauri upgrade.
* Remotion (custom license) and other heavy tooling were evaluated and **not** added.

## 4. What we knowingly do not protect (and why)

1. **No TLS on the classroom channel.** A self-signed certificate does not solve first trust without a CA; the
   right design is a certificate pinned through the join code. Until then policies are visible to the LAN and
   signed requests can be observed. Integrity and authenticity hold; confidentiality of *class rules* does not.
   Nothing private is in that traffic by design.
2. **Device-key storage is not hardware- or keychain-backed** (see above).
3. **Class rules are not tamper-proof on the student's machine** (nothing can be, without elevated OS control, which
   this app does not and will not request).
4. **Rogue advertiser (mDNS).** Discovery only supplies an address. A rogue host cannot produce a valid policy (no
   class key) or learn secrets, but can receive one signed request that could be replayed to the real host within
   120 s (yielding only the public policy stream) and can deny service.
5. **Administrator recovery is intentionally limited**: no recovery material → no recovery. There is no back door.
6. **Windows and macOS** builds and OS-keychain/permission behaviours are unverified.

## 5. Reporting and hygiene
Run `cargo audit`, `npm audit`, `cargo clippy --workspace --all-targets` and the full test matrix in `TESTING.md`
before release. Treat any new native command or capability as a security change and add a test beside the existing
ACL test.
