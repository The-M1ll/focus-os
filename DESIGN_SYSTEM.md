# Design system

Source of truth: `src/design/tokens.css`, `base.css`, `components.css`, `ui.tsx`. This file explains the intent so
new screens stay coherent.

## Direction: an editorial instrument panel
FOCUS OS should feel like a well-made printed timetable crossed with a watch face: calm, exact, a little literary.
It is deliberately **not** a sidebar of identical rounded cards.

* **Structure comes from typography, hairline rules and whitespace**, not boxes. Lists are ruled rows; sections have
  a numbered mono label (`01 — Next up`) over a serif title. A card/box is used only where the content is genuinely a
  contained object (dialogs, toasts).
* **Navigation is a masthead**: wordmark, text links with a single sliding accent underline (`layoutId`), a command
  palette hint and settings. Numbered keys `1–6` mirror the links.
* **One signature object: the dial.** The timer is a 60-tick watch face built from real geometry (arc, ticks, knob),
  in Fraunces numerals. It is the only large decorative element and it is functional: it *is* the progress display.
* **One accent.** Lime on graphite (dark) / deep olive on ivory (light). Semantic colours (warn amber, danger coral,
  info blue) appear only as small status text/borders and are **always accompanied by words or icons**.
* **Honest status is part of the style**: every rule/connection shows a pill with plain words
  (`Enforced in browser` / `Not enforced`, `Live` / `Host unreachable`).

Avoided on purpose: purple/blue gradients, glassmorphism (the masthead uses a subtle blur only to stay legible over
scrolling content), neon, coloured-circle icons, fake charts/terminals/statuses, repeated identical sections,
motivational slogans, streaks, scores.

## Tokens
| Group | Values |
|---|---|
| Type | Display **Fraunces** (variable, optical size 144, SOFT axis) · UI **Inter** (variable) · Mono **JetBrains Mono** (labels, addresses, code). Bundled locally; no network fonts. |
| Scale | 11 / 13 / 15 / 18 / 22 / 32 / 48 px, dial `clamp(3.5rem, 9vw, 6.5rem)` |
| Space | 4-px base: 4 · 8 · 12 · 16 · 24 · 32 · 48 · 72 |
| Radii | **three only**: 6 (inputs inner/kbd), 10 (fields, dialogs), pill (buttons, pills, switches) |
| Dark | bg `#0e0e0f`, raised `#151516`, line `#262628`, text `#f2ede0`, text-2 `#bdb7a8`, text-3 `#8e8979`, accent `#cfef5b` (on `#12140a`) |
| Light | bg `#f6f2e7`, line `#ddd6c3`, text `#17160f`, text-3 `#6b6757`, accent `#5b7a00` (on `#fbf8ef`) |
| Motion | ease-out `cubic-bezier(.22,1,.36,1)`; 120 / 220 / 420 ms |

Contrast is enforced, not assumed: axe-core runs on every screen in both themes in CI-style Playwright tests, and its
ability to detect contrast failures is itself tested (`harness self-check`).

## Components (`src/design/ui.tsx`)
`Button` (default / primary / quiet / danger, sm / md / lg, `busy`), `IconButton` (label required), `Field`
(binds label, hint and error to the control with `aria-describedby`/`aria-invalid`; errors announce via `role="alert"`),
`Input`/`TextArea`/`Select`, `Switch` (real checkbox with `role="switch"`), `Segmented` (radio group), `Pill`, `Meter`
(`role="meter"`), `Banner`, `SectionHead`, `Empty`, `Dialog`, `Toasts`, `Kbd`, `Markdown` (safe renderer).

* **Dialog** is a native `<dialog>` mounted only while open: native focus trap and Escape, inert background, focus
  goes to the first field (or stays on *Close* for confirm-only dialogs, the safe default), and returns to the opener on close.
* **Forms** validate on submit with specific messages ("An allowed-hours rule must end after it starts"), never
  clearing what the user typed. Destructive actions say exactly what is lost; deletes that can be undone offer **Undo**.
* **Empty states** are written invitations that explain the next step and the benefit, with one action.
* **Status never relies on colour**: pills carry words; meters have `aria-valuenow`; the dial has a text label and `role="timer"`.

## Motion
Motion explains state change; it never delays an action. Used for: route fade (220 ms), nav underline, timer control
swaps (180 ms), dialog open, the first-run sequence (≈ 2 s, skippable at every step), arc pulse on completion.
`MotionConfig` honours the OS setting and the in-app *Animation* setting (`System / Reduced / Full`); CSS animations and
transitions are collapsed to ~0 ms (including delays) under reduced motion. Verified in Playwright. No parallax,
particles or cursor effects. The timer's ring uses a 1-second linear transition that exists only to show elapsed time.

## Layout and responsiveness
Max content width 1280 px with 24-px gutters; two-column "7/5" asymmetry on Today; sticky masthead 56 px with
`scroll-padding` so keyboard focus is never hidden beneath it (WCAG 2.4.11). Below 980 px grids collapse to one
column and nav indices hide; below 760 px nav tightens. Tested for no horizontal overflow at 1280×820, 900×640
and 760×560 on all seven screens. The Tauri window's minimum size is 760×560.

## Accessibility checklist for new UI
Semantic landmarks and one `h1` per screen; every control has an accessible name; visible 2-px accent focus ring;
keyboard-complete (tabs, dialogs, palette, review keys `Space`/`1–4`); live regions for save status, toasts and timer
completion (the timer itself is `aria-live="off"` to avoid announcing every second); targets ≥ 32 px; reduced motion;
no information conveyed by colour alone; run `npx playwright test -g accessibility`.
