import { acknowledge, anchorState, completedInRow, dueReminders, isQuietHours, nextBreak, snooze, type WellnessConfig } from './wellness';
import type { ReminderState } from './schemas';

const cfg = (o: Partial<WellnessConfig> = {}): WellnessConfig => ({
  eyeRest: { enabled: true, everyMin: 20 },
  movement: { enabled: true, everyMin: 50 },
  quiet: { enabled: true, start: '22:00', end: '07:00' },
  delivery: 'in-app',
  ...o,
});
const at = (h: number, m = 0) => Date.UTC(2026, 2, 2, h, m);
const st = (o: Partial<ReminderState> = {}): ReminderState => ({ id: 'state', lastEyeAt: 0, lastMoveAt: 0, snoozedUntil: 0, ...o });

describe('quiet hours', () => {
  it('handles spans across midnight', () => {
    const q = cfg().quiet;
    expect(isQuietHours(at(23), 'UTC', q)).toBe(true);
    expect(isQuietHours(at(3), 'UTC', q)).toBe(true);
    expect(isQuietHours(at(7), 'UTC', q)).toBe(false);
    expect(isQuietHours(at(12), 'UTC', q)).toBe(false);
    expect(isQuietHours(at(21, 59), 'UTC', q)).toBe(false);
  });
  it('handles same-day spans, disabled and degenerate settings', () => {
    expect(isQuietHours(at(13), 'UTC', { enabled: true, start: '12:00', end: '14:00' })).toBe(true);
    expect(isQuietHours(at(15), 'UTC', { enabled: true, start: '12:00', end: '14:00' })).toBe(false);
    expect(isQuietHours(at(23), 'UTC', { enabled: false, start: '22:00', end: '07:00' })).toBe(false);
    expect(isQuietHours(at(23), 'UTC', { enabled: true, start: '08:00', end: '08:00' })).toBe(false);
  });
  it('uses the student time zone', () => {
    expect(isQuietHours(at(18), 'Asia/Tashkent', cfg().quiet)).toBe(true); // 23:00 local
  });
});

describe('reminders', () => {
  const base = { tz: 'UTC', focusRunning: true };
  it('are due only after a full interval of observed focus time', () => {
    const s = anchorState(st(), at(10));
    expect(dueReminders({ ...base, now: at(10, 19), config: cfg(), state: s })).toEqual([]);
    expect(dueReminders({ ...base, now: at(10, 20), config: cfg(), state: s }).map((r) => r.kind)).toEqual(['eye-rest']);
    expect(dueReminders({ ...base, now: at(10, 50), config: cfg(), state: s }).map((r) => r.kind)).toEqual(['eye-rest', 'movement']);
  });
  it('are silent outside focus, in quiet hours, when snoozed, or switched off', () => {
    const s = anchorState(st(), at(21));
    expect(dueReminders({ ...base, focusRunning: false, now: at(21, 30), config: cfg(), state: s })).toEqual([]);
    expect(dueReminders({ ...base, now: at(22, 30), config: cfg(), state: s })).toEqual([]);
    const s2 = snooze(anchorState(st(), at(10)), at(10, 25), 15);
    expect(dueReminders({ ...base, now: at(10, 30), config: cfg(), state: s2 })).toEqual([]);
    expect(dueReminders({ ...base, now: at(10, 41), config: cfg(), state: s2 }).length).toBe(1);
    expect(dueReminders({ ...base, now: at(10, 59), config: cfg({ delivery: 'off' }), state: anchorState(st(), at(10)) })).toEqual([]);
    expect(dueReminders({ ...base, now: at(10, 59), config: cfg({ eyeRest: { enabled: false, everyMin: 20 }, movement: { enabled: false, everyMin: 50 } }), state: anchorState(st(), at(10)) })).toEqual([]);
  });
  it('never fire on a brand-new state (no instant reminder when the app opens)', () => {
    expect(dueReminders({ ...base, now: at(10), config: cfg(), state: st() })).toEqual([]);
  });
  it('acknowledging restarts only that reminder', () => {
    const s = acknowledge(anchorState(st(), at(10)), 'eye-rest', at(10, 20));
    expect(dueReminders({ ...base, now: at(10, 21), config: cfg(), state: s })).toEqual([]);
    expect(s.lastMoveAt).toBe(at(10));
  });
});

describe('breaks', () => {
  const focus = { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, cyclesBeforeLong: 4 };
  it('every Nth completed block earns the long break', () => {
    expect(nextBreak(1, focus)).toEqual({ kind: 'short', minutes: 5 });
    expect(nextBreak(3, focus)).toEqual({ kind: 'short', minutes: 5 });
    expect(nextBreak(4, focus)).toEqual({ kind: 'long', minutes: 15 });
    expect(nextBreak(8, focus)).toEqual({ kind: 'long', minutes: 15 });
    expect(nextBreak(0, focus).kind).toBe('short');
  });
  it('counts only completed focus blocks since the last long break, today', () => {
    const f = (t: number, outcome = 'completed') => ({ kind: 'focus' as const, outcome, endedAt: t, plannedMs: 25 * 60_000 });
    const lb = (t: number) => ({ kind: 'break' as const, outcome: 'completed', endedAt: t, plannedMs: 15 * 60_000 });
    expect(completedInRow([f(10), f(20), f(30, 'stopped')], 0)).toBe(2);
    expect(completedInRow([f(10), f(20), lb(25), f(30)], 0)).toBe(1);
    expect(completedInRow([f(10)], 50)).toBe(0);
  });
});
