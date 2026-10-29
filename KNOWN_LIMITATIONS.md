# Known limitations

Ordered by how much they matter to a student or teacher. Each item says what is true today and what, if anything,
mitigates it. Nothing here is hidden in the UI: the Settings screen and the relevant screens state the same facts.

## Enforcement (Digital Life Control)
1. **Websites are measured and blocked only in a Chromium browser with the FOCUS OS extension. Desktop apps are
   limited by the desktop app itself, and only on the computer it runs on.** Phone/tablet apps are never covered; time
   there can only be added by the student and is labelled **self-reported**.
   * **Apps (desktop):** time means how long an app's *process is open*, not how long its window is in front. A game
     left open in the background keeps counting. Apps are matched by **exact process or executable name** (plus a short built-in list
     of aliases for well-known games and launchers); anything whose process name differs from the name entered is not
     found, and Java-edition Minecraft runs as `java`/`javaw`, which is deliberately not matched. The list of installed
     apps is best-effort (macOS `/Applications`, Linux `.desktop` files, Windows Start Menu shortcuts, whose names do not
     always equal the process name); running programs are always exact.
   * **Closing is warn-then-close.** The student gets a warning (60 s the first time, 10 s if already warned or if the
     app is reopened within five minutes), then the app is asked to quit (SIGTERM on macOS/Linux) and, if still open
     20 s later, ended. **On Windows there is no polite request in this version: the process is ended**, so unsaved
     work in that app is lost after the warning. Games can ignore or restart themselves; a launcher that relaunches its
     game will be closed again each time.
   * **Never touched:** the operating system's own processes, shells and terminals, web browsers (they are limited per
     website through the extension) and FOCUS OS itself. A rule naming one is ignored and reported on the Apps screen.
   * Class app rules are as strong as the student's cooperation: they can switch enforcement to *Remind only* or
     *Off* (the screen then says "Not enforced"), quit FOCUS OS, or rename a program. Nothing reports compliance back to
     the teacher, by design.
   * **Windows and macOS: process listing, polite close, notifications and the installed-app scan are untested**
     (verified only on Linux with real processes). Treat the first run there as the first verification.
2. **Chromium browsers only** (Chrome, Edge, Brave — Manifest V3). Firefox and Safari are not supported. The
   extension must be loaded unpacked (`extension/dist`); it is not published to a store.
3. **Enforcement is only as strong as the student's cooperation.** The extension can be disabled or removed; the
   status then turns to "not enforced" within two minutes (this is measured, not assumed) but nothing prevents it.
   Likewise a student can edit their own local database. Class rules are coordination with honest status, not a lock.
4. **Private/incognito windows** are not covered unless the user allows the extension there.
5. **Measurement is foreground time**: the focused window's active tab, with the user not idle for 60 s, in 30-second
   steps (≤ 45 s credited per step). Audio-only tabs in the background and split-screen windows are not counted.
6. Custom websites beyond the six built-ins need the extension's optional host permission (granted in the browser).

## Classroom
7. **The host computer must be on, unlocked and reachable.** There is no relay or store-and-forward. If it is off,
   members keep their last policy and study tools, see a truthful "host unreachable" state and a "last updated" time,
   and cannot receive changes. If the host is lost and there is no recovery bundle, **the class cannot be recovered.**
8. **No transport encryption (TLS)** on the classroom channel. Integrity/authenticity are signature-based; rules are
   visible to the LAN (they contain nothing private). Planned: certificate pinning via the join code.
9. **Networks that isolate devices** (guest Wi-Fi, many school networks) block the classroom entirely; the UI explains
   this and offers manual address entry, but it cannot work around it. mDNS is often blocked too.
10. **IPv4 only.** Address changes are handled by mDNS re-discovery or manual entry.
11. **Device keys are stored in the app's database, not the OS keychain.** They are per class and carry no study data.
12. **One administrator, no teacher/guardian role.** The roster shows names, online state and acknowledged revision
    only. Family/guardian views are **not implemented**; the protocol deliberately has no channel for progress
    (`progress_sharing: "none"`) so adding one must be an explicit, versioned, consented change.
13. **The host's clock matters.** Requests more than 2 minutes (join: 5) off are refused with a clear message.
14. Not load-tested: 256 simultaneous WebSocket members, rate-limit thresholds, large rosters.

## Learning and planning
15. **No AI features.** Generating questions/explanations was intentionally not built (network dependency and unverified
    output). Everything works from the student's own material.
16. Flashcards are **text only** (no images/audio). Notes are Markdown text with a preview; no embedded media, no
    images, no collaborative editing.
17. Search is a simple in-memory substring search (notes, cards, palette); there is no full-text ranking or fuzzy match.
18. The planner is advisory and heuristic; it does not read calendars or school systems, and capacity is a single daily number.
19. Personal data is held in memory while the app runs; designed for student-scale data (thousands of cards/notes),
    not hundreds of thousands.

## Platform and release
20. **Windows and macOS are unverified.** Only Linux was built and tested. Expect to verify packaging, notification
    permission flows, firewall prompts for the host, WebView2/WKWebView rendering and mDNS there.
21. System notifications are wired through the official Tauri plugin but delivery was not observed on any OS; in-app
    reminders are the reliable path. Delivery failures are reported to the user, not swallowed.
22. Accessibility is machine-checked (axe-core: 0 violations on all screens, light and dark; focus trapping; reduced
    motion; keyboard operation) but **no human screen-reader testing** has been done.
23. The UI is English only; dates use the system locale for display.
24. No code signing, auto-update or installer customisation.
25. The browser-preview mode (plain browser) stores data in `localStorage`, has no classroom, bridge or native
    backups of its own, and is for development/testing only.

## Dependencies
26. `cargo audit` reports 0 vulnerabilities but 5 informational warnings (unmaintained/unsound crates inside Tauri's
    Linux GTK/notification dependency tree). Re-check on each Tauri update.
27. The frontend entry chunk is ~530 kB (before gzip ~170 kB); screens are lazy-loaded. Acceptable for a desktop app,
    not optimised further.

## Prioritised roadmap
1. Verify and package on Windows and macOS; CI for all three.
2. TLS with a certificate pinned through the join code; move device keys to the OS keychain.
3. Native foreground-app measurement (opt-in, no blocking) on Windows/macOS; Firefox extension.
4. A human accessibility pass with NVDA/VoiceOver; keyboard-only usability study with students.
5. Teacher role and an explicit, consented, minimal "weekly focus minutes" share for family/guardian views.
6. Images in notes/flashcards; import from common flashcard formats.
7. Optional, clearly-labelled AI helpers that run locally or with the student's own key, never required.
