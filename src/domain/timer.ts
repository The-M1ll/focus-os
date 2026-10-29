/**
 * Focus timer as a pure state machine.
 *
 * Time model: the timer records *active segments* (wall-clock start/end pairs).
 * While running, a heartbeat records the last instant at which we know the app was alive.
 * If the next heartbeat arrives later than GAP_MS (system sleep, app closed, crash) the gap
 * is NOT counted: the timer stops counting at the last heartbeat and moves to "paused" with
 * reason "interrupted" so the user decides whether to continue. An active timer is never
 * treated as proof of attention; it only measures time the app was running.
 */

import { type DayRules, dayKey, dayStartMs, addDays } from './time';

export const GAP_MS = 150_000; // > Chromium's 60 s background-timer throttle
export const HEARTBEAT_MS = 5_000;

export type TimerKind = 'focus' | 'break';
export type TimerStatus = 'running' | 'paused' | 'finished';
export type PauseReason = 'user' | 'interrupted';

export interface Segment {
  start: number;
  end: number | null; // null = currently open
}

export interface ActiveTimer {
  id: string;
  kind: TimerKind;
  plannedMs: number;
  subjectId?: string;
  taskId?: string;
  label?: string;
  status: TimerStatus;
  segments: Segment[];
  lastHeartbeat: number;
  pauseReason?: PauseReason;
  /** Instant the user-visible target was reached (status = finished). */
  reachedAt?: number;
}

export interface StartOptions {
  id: string;
  kind: TimerKind;
  plannedMs: number;
  subjectId?: string;
  taskId?: string;
  label?: string;
}

export function start(opts: StartOptions, now: number): ActiveTimer {
  if (!(opts.plannedMs > 0)) throw new Error('plannedMs must be positive');
  return { ...opts, status: 'running', segments: [{ start: now, end: null }], lastHeartbeat: now };
}

/** Active milliseconds measured so far, never more than we actually observed. */
export function activeMs(t: ActiveTimer): number {
  let total = 0;
  for (const s of t.segments) {
    const end = s.end ?? t.lastHeartbeat;
    total += Math.max(0, end - s.start);
  }
  return total;
}

export function remainingMs(t: ActiveTimer): number {
  return Math.max(0, t.plannedMs - activeMs(t));
}

function closeOpen(t: ActiveTimer, at: number): Segment[] {
  return t.segments.map((s) => (s.end === null ? { start: s.start, end: Math.max(s.start, at) } : s));
}

/**
 * Advance a running timer to `now`. Detects sleep/suspension gaps and completion.
 * Pure: returns a new state.
 */
export function tick(t: ActiveTimer, now: number): ActiveTimer {
  if (t.status !== 'running') return t;
  if (now < t.lastHeartbeat) {
    // The wall clock moved backwards (manual change/NTP). Don't count negative time; re-anchor.
    // Keep everything counted so far; continue in a fresh segment from the new "now".
    return { ...t, lastHeartbeat: now, segments: [...closeOpen(t, t.lastHeartbeat), { start: now, end: null }] };
  }
  if (now - t.lastHeartbeat > GAP_MS) {
    return { ...t, status: 'paused', pauseReason: 'interrupted', segments: closeOpen(t, t.lastHeartbeat) };
  }
  const advanced: ActiveTimer = { ...t, lastHeartbeat: now };
  const used = activeMs(advanced);
  if (used >= t.plannedMs) {
    // Trim so recorded focus time never exceeds what was planned.
    const overshoot = used - t.plannedMs;
    const reached = now - overshoot;
    return { ...advanced, status: 'finished', reachedAt: reached, segments: closeOpen(advanced, reached), lastHeartbeat: reached };
  }
  return advanced;
}

export function pause(t: ActiveTimer, now: number): ActiveTimer {
  if (t.status !== 'running') return t;
  const t2 = tick(t, now);
  if (t2.status !== 'running') return t2; // finished or interrupted while we were looking
  return { ...t2, status: 'paused', pauseReason: 'user', segments: closeOpen(t2, t2.lastHeartbeat) };
}

export function resume(t: ActiveTimer, now: number): ActiveTimer {
  if (t.status !== 'paused') return t;
  return { ...t, status: 'running', pauseReason: undefined, segments: [...t.segments, { start: now, end: null }], lastHeartbeat: now };
}

/** Add more planned time (e.g. "5 more minutes") to an unfinished or finished timer. */
export function extend(t: ActiveTimer, extraMs: number, now: number): ActiveTimer {
  if (extraMs <= 0) return t;
  const base = { ...t, plannedMs: t.plannedMs + extraMs };
  if (t.status === 'finished') {
    return { ...base, status: 'running', reachedAt: undefined, segments: [...t.segments, { start: now, end: null }], lastHeartbeat: now };
  }
  return base;
}

/**
 * Recovery after app start. Whatever the persisted state was, we never count time we did not
 * observe: a running timer is closed at its last heartbeat and presented as interrupted.
 */
export function recover(t: ActiveTimer, now: number): ActiveTimer {
  if (t.status === 'running') {
    if (now - t.lastHeartbeat <= HEARTBEAT_MS * 2) return tick(t, now);
    return { ...t, status: 'paused', pauseReason: 'interrupted', segments: closeOpen(t, t.lastHeartbeat) };
  }
  return t;
}

export interface SessionRecord {
  id: string;
  kind: TimerKind;
  subjectId?: string;
  taskId?: string;
  label?: string;
  plannedMs: number;
  activeMs: number;
  startedAt: number;
  endedAt: number;
  segments: { start: number; end: number }[];
  /** completed = reached the planned time; stopped = ended early by the user; interrupted = ended while interrupted. */
  outcome: 'completed' | 'stopped' | 'interrupted';
}

/** Close a timer into an immutable history record. */
export function finalize(t: ActiveTimer, now: number): SessionRecord {
  let c = t;
  if (c.status === 'running') c = pause(c, now);
  const segs = c.segments.filter((s): s is { start: number; end: number } => s.end !== null && s.end > s.start);
  const used = segs.reduce((a, s) => a + (s.end - s.start), 0);
  const first = segs[0]?.start ?? t.segments[0]?.start ?? now;
  const last = segs[segs.length - 1]?.end ?? first;
  const outcome: SessionRecord['outcome'] =
    c.status === 'finished' ? 'completed' : c.pauseReason === 'interrupted' ? 'interrupted' : 'stopped';
  return {
    id: c.id,
    kind: c.kind,
    subjectId: c.subjectId,
    taskId: c.taskId,
    label: c.label,
    plannedMs: c.plannedMs,
    activeMs: used,
    startedAt: first,
    endedAt: last,
    segments: segs,
    outcome,
  };
}

/** Minutes of active time per study-day, clipping segments at day boundaries (midnight-safe). */
export function minutesByDay(records: Pick<SessionRecord, 'segments' | 'kind'>[], rules: DayRules, kind: TimerKind = 'focus'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) {
    if (r.kind !== kind) continue;
    for (const s of r.segments) {
      let cur = s.start;
      while (cur < s.end) {
        const k = dayKey(cur, rules);
        const nextStart = dayStartMs(addDays(k, 1), rules);
        const stop = Math.min(s.end, nextStart);
        out[k] = (out[k] ?? 0) + (stop - cur) / 60_000;
        if (stop <= cur) break; // defensive: a misbehaving tz database must not hang the UI
        cur = stop;
      }
    }
  }
  return out;
}
