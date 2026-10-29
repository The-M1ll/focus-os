/**
 * Gentle reminders. The student controls frequency and availability; nothing here makes
 * medical claims. Reminders count only *running focus time* the app actually observed.
 */

import { minutesOfDay } from './time';
import type { ReminderState, Settings } from './schemas';

export type WellnessConfig = Settings['wellness'];

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Quiet hours may span midnight (22:00-07:00). start == end means "never quiet". */
export function isQuietHours(ms: number, tz: string, quiet: WellnessConfig['quiet']): boolean {
  if (!quiet.enabled) return false;
  const s = toMin(quiet.start);
  const e = toMin(quiet.end);
  if (s === e) return false;
  const m = minutesOfDay(ms, tz);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

export type ReminderKind = 'eye-rest' | 'movement';

export interface DueReminder {
  kind: ReminderKind;
  title: string;
  body: string;
}

export interface ReminderInput {
  now: number;
  tz: string;
  config: WellnessConfig;
  state: ReminderState;
  /** Is a focus session actively running right now? */
  focusRunning: boolean;
}

export const COPY: Record<ReminderKind, { title: string; body: string }> = {
  'eye-rest': { title: 'Rest your eyes', body: 'Look at something far away for about 20 seconds.' },
  movement: { title: 'Stretch if you like', body: 'Stand up, roll your shoulders, take a few steps.' },
};

/**
 * Returns the reminders due *now*. A reminder is never due outside focus time, during quiet hours,
 * while snoozed, or when switched off. Timers start from the first time we observe a focus session,
 * so opening the app never triggers an immediate reminder.
 */
export function dueReminders(i: ReminderInput): DueReminder[] {
  const { now, config, state } = i;
  if (config.delivery === 'off' || !i.focusRunning) return [];
  if (state.snoozedUntil > now || isQuietHours(now, i.tz, config.quiet)) return [];
  const out: DueReminder[] = [];
  if (config.eyeRest.enabled && state.lastEyeAt > 0 && now - state.lastEyeAt >= config.eyeRest.everyMin * 60_000) out.push({ kind: 'eye-rest', ...COPY['eye-rest'] });
  if (config.movement.enabled && state.lastMoveAt > 0 && now - state.lastMoveAt >= config.movement.everyMin * 60_000) out.push({ kind: 'movement', ...COPY.movement });
  return out;
}

/** Anchor timers the first time a focus session is seen so the first reminder is a full interval away. */
export function anchorState(state: ReminderState, now: number): ReminderState {
  return { ...state, lastEyeAt: state.lastEyeAt || now, lastMoveAt: state.lastMoveAt || now };
}

export function acknowledge(state: ReminderState, kind: ReminderKind, now: number): ReminderState {
  return kind === 'eye-rest' ? { ...state, lastEyeAt: now } : { ...state, lastMoveAt: now };
}

export function snooze(state: ReminderState, now: number, minutes: number): ReminderState {
  return { ...state, snoozedUntil: now + minutes * 60_000 };
}

export interface BreakSuggestion {
  kind: 'short' | 'long';
  minutes: number;
}

/** After `completedInRow` finished focus blocks, the next break is long every Nth block. */
export function nextBreak(completedInRow: number, focus: Settings['focus']): BreakSuggestion {
  const isLong = completedInRow > 0 && completedInRow % focus.cyclesBeforeLong === 0;
  return isLong ? { kind: 'long', minutes: focus.longBreakMin } : { kind: 'short', minutes: focus.shortBreakMin };
}

/** Counts finished focus sessions since the last long break, newest-first input not required. */
export function completedInRow(sessions: { kind: 'focus' | 'break'; outcome: string; endedAt: number; plannedMs: number }[], dayStart: number): number {
  const s = sessions.filter((x) => x.endedAt >= dayStart).sort((a, b) => a.endedAt - b.endedAt);
  let n = 0;
  for (const x of s) {
    if (x.kind === 'focus' && x.outcome === 'completed') n++;
    else if (x.kind === 'break' && x.outcome === 'completed' && x.plannedMs >= 10 * 60_000) n = 0; // a long break resets the cycle
  }
  return n;
}
