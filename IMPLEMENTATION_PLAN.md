# Implementation plan

Phases follow the brief. **One deliberate reordering:** the classroom core (Phases 7–8) was built and tested first
because it carried the highest technical risk (local networking, authority, crypto, recovery) and let every later UI
phase be built against a verified foundation. Each phase ended with a runnable app and tests.

| # | Phase | Outcome | Status |
|---|---|---|---|
| 0 | Audit & research | Empty repo; toolchain checked (Node 22, Rust 1.97, WebKitGTK installed); tool evaluation recorded in `ARCHITECTURE.md` §6 | ✅ |
| 7–8 (first) | Serverless classroom core | Rust crate: SQLite migrations, Ed25519/HMAC/Argon2id, pairing, host service, HTTP+WebSocket, client sync, audit chain, transfer/recovery; 26 tests incl. real sockets | ✅ |
| 2 | Local data foundation | `personal.db` documents + migrations, atomic writes, verified backups, import validation | ✅ |
| 1 | Design foundation | Tokens, primitives, masthead shell, palette, first-run | ✅ |
| 3 | Focus system | Timer state machine, persistence, recovery, history | ✅ |
| 4 | Learning engine | Notes/autosave, flashcards, SRS, quizzes, mistakes, search | ✅ |
| 5 | Planner | Tasks, estimates, week, exams, revision plans, weekly review | ✅ |
| 6 | Limits | Budgets/hours/weekdays, usage honesty, extension + loopback bridge | ✅ |
| 9 | Class policy integration | Precedence engine merging class and personal rules; bridge payload | ✅ |
| 10 | Wellness | Reminders, quiet hours, breaks | ✅ (system notifications unobserved) |
| 11 | Refinement | React-compiler lint compliance, a11y (axe 0 violations), small windows, scroll-padding, honest preview states | ✅ |
| 12 | Release readiness | Full verification matrix; Linux `.deb`; docs | 🟡 Windows/macOS pending |

## Acceptance of the first vertical slice (defined before building)
1. A class can be created with no internet and a second instance joins using only a code. ✅ (`network`, IPC, native e2e)
2. A policy change reaches a connected client, is verified, persisted and acknowledged. ✅
3. A client that was offline receives the *latest* revision on reconnect, not intermediate ones. ✅
4. Unauthorised/replayed/forged requests change nothing. ✅
5. Host restart and client restart preserve state; the UI reports host loss truthfully. ✅

## Next milestones
1. **Cross-platform:** CI for Windows/macOS/Linux; fix what appears; sign and notarise.
2. **Security hardening:** pinned-certificate TLS; OS keychain for device keys; fuzz the join/policy parsers.
3. **Field trial:** two or more physical computers on a school-like network; measure unlock time and reconnect behaviour.
4. **Accessibility:** NVDA/VoiceOver/Orca pass; keyboard-only usability study.
5. **Product:** teacher role and an opt-in minimal share for guardians; images in notes/cards; Firefox extension;
   optional local/own-key AI helpers clearly labelled.
