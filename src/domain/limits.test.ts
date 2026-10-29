import { aggregateUsage, combineRules, evaluate, extensionLink, isAvailableAt, toBridgeRules, BUILTIN_PLATFORMS, type ClassPolicyView, type Window } from './limits';
import type { PersonalLimit } from './schemas';

const TZ = 'UTC';
// Monday 2026-03-02 15:00 UTC
const MON_15 = Date.UTC(2026, 2, 2, 15, 0);
const SAT_15 = Date.UTC(2026, 2, 7, 15, 0);

const personal = (o: Partial<PersonalLimit> = {}): PersonalLimit => ({ id: 'p', platform: 'instagram', dailyMinutes: 30, days: [0, 1, 2, 3, 4, 5, 6], allowedStart: null, allowedEnd: null, warnAtPct: 80, enabled: true, createdAt: 0, ...o });
const klass = (limits: ClassPolicyView['limits'], o: Partial<ClassPolicyView> = {}): ClassPolicyView => ({ classId: 'c1', className: '10B', revision: 4, receivedAt: 0, limits, allowPersonalLimits: true, ...o });
const rule = (platform: string, o: Partial<ClassPolicyView['limits'][number]> = {}) => ({ platform, blocked: false, daily_minutes: null, allowed_windows: [], ...o });

describe('windows', () => {
  const weekdays4to6: Window[] = [{ days: [1, 2, 3, 4, 5], start_min: 16 * 60, end_min: 18 * 60 }];
  it('is available only inside allowed hours on allowed days', () => {
    expect(isAvailableAt(weekdays4to6, Date.UTC(2026, 2, 2, 16, 30), TZ)).toBe(true);
    expect(isAvailableAt(weekdays4to6, MON_15, TZ)).toBe(false);
    expect(isAvailableAt(weekdays4to6, Date.UTC(2026, 2, 7, 16, 30), TZ)).toBe(false); // Saturday
    expect(isAvailableAt([], MON_15, TZ)).toBe(true);
  });
  it('evaluates in the configured zone', () => {
    const w: Window[] = [{ days: [], start_min: 20 * 60, end_min: 22 * 60 }];
    // 16:00 UTC is 21:00 in Tashkent (UTC+5)
    expect(isAvailableAt(w, Date.UTC(2026, 2, 2, 16, 0), 'Asia/Tashkent')).toBe(true);
    expect(isAvailableAt(w, Date.UTC(2026, 2, 2, 16, 0), 'UTC')).toBe(false);
  });
});

describe('precedence', () => {
  it('class block beats everything and personal rules cannot loosen it', () => {
    const r = combineRules([personal({ dailyMinutes: 120 })], [klass([rule('instagram', { blocked: true })])], MON_15);
    expect(r[0]).toMatchObject({ blocked: true, dailyLimitMin: null });
  });
  it('the stricter budget wins in either direction', () => {
    expect(combineRules([personal({ dailyMinutes: 60 })], [klass([rule('instagram', { daily_minutes: 20 })])], MON_15)[0]!.dailyLimitMin).toBe(20);
    expect(combineRules([personal({ dailyMinutes: 10 })], [klass([rule('instagram', { daily_minutes: 20 })])], MON_15)[0]!.dailyLimitMin).toBe(10);
  });
  it('strictest of several classes applies', () => {
    const a = klass([rule('youtube', { daily_minutes: 60 })], { classId: 'a', className: 'A' });
    const b = klass([rule('youtube', { daily_minutes: 30 })], { classId: 'b', className: 'B' });
    const r = combineRules([], [a, b], MON_15)[0]!;
    expect(r.dailyLimitMin).toBe(30);
    expect(r.origins).toHaveLength(2);
  });
  it('personal rules are ignored (and explained) when the class forbids them', () => {
    const r = combineRules([personal({ dailyMinutes: 5 })], [klass([rule('instagram', { daily_minutes: 20 })], { allowPersonalLimits: false })], MON_15)[0]!;
    expect(r.dailyLimitMin).toBe(20);
    expect(r.inactivePersonal).toMatch(/does not allow/);
  });
  it('one forbidding class disables personal rules everywhere', () => {
    const ok = klass([], { classId: 'ok' });
    const no = klass([], { classId: 'no', allowPersonalLimits: false });
    const r = combineRules([personal()], [ok, no], MON_15)[0]!;
    expect(r.inactivePersonal).toBeDefined();
    expect(r.dailyLimitMin).toBeNull();
  });
  it('paused and disabled personal rules are inactive with a reason', () => {
    expect(combineRules([personal({ pausedUntil: MON_15 + 1000 })], [], MON_15)[0]!.inactivePersonal).toBe('Paused');
    expect(combineRules([personal({ pausedUntil: MON_15 - 1 })], [], MON_15)[0]!.inactivePersonal).toBeUndefined();
    expect(combineRules([personal({ enabled: false })], [], MON_15)[0]!.inactivePersonal).toBe('Switched off');
  });
  it('allowed hours intersect', () => {
    const c = klass([rule('instagram', { allowed_windows: [{ days: [], start_min: 16 * 60, end_min: 20 * 60 }] })]);
    const r = combineRules([personal({ allowedStart: 18 * 60, allowedEnd: 22 * 60, dailyMinutes: null })], [c], MON_15)[0]!;
    expect(isAvailableAt(r.windows, Date.UTC(2026, 2, 2, 17, 0), TZ)).toBe(false);
    expect(isAvailableAt(r.windows, Date.UTC(2026, 2, 2, 19, 0), TZ)).toBe(true);
    expect(isAvailableAt(r.windows, Date.UTC(2026, 2, 2, 21, 0), TZ)).toBe(false);
  });
  it('selected weekdays become availability', () => {
    const r = combineRules([personal({ days: [1, 2, 3, 4, 5], dailyMinutes: 30 })], [], MON_15)[0]!;
    expect(isAvailableAt(r.windows, MON_15, TZ)).toBe(true);
    expect(isAvailableAt(r.windows, SAT_15, TZ)).toBe(false);
  });
});

describe('evaluation', () => {
  const eff = (o = {}) => ({ platform: 'youtube', blocked: false, dailyLimitMin: 30, windows: [] as Window[], origins: [], ...o });
  it('walks ok -> warning -> exhausted using measured + self-reported minutes', () => {
    expect(evaluate(eff(), { measuredSec: 600, selfReportedSec: 0 }, MON_15, TZ, 'connected').state).toBe('ok');
    const w = evaluate(eff(), { measuredSec: 1500, selfReportedSec: 0 }, MON_15, TZ, 'connected');
    expect(w.state).toBe('warning');
    expect(w.remainingMin).toBeCloseTo(5);
    expect(evaluate(eff(), { measuredSec: 600, selfReportedSec: 1200 }, MON_15, TZ, 'connected').state).toBe('exhausted');
  });
  it('keeps measured and self-reported separate in the result', () => {
    const e = evaluate(eff(), { measuredSec: 600, selfReportedSec: 300 }, MON_15, TZ, 'connected');
    expect(e.measuredMin).toBe(10);
    expect(e.selfReportedMin).toBe(5);
    expect(e.usedMin).toBe(15);
  });
  it('reports hours/blocked/no-budget states', () => {
    expect(evaluate(eff({ blocked: true }), { measuredSec: 0, selfReportedSec: 0 }, MON_15, TZ, 'connected').state).toBe('blocked');
    expect(evaluate(eff({ windows: [{ days: [], start_min: 0, end_min: 60 }] }), { measuredSec: 0, selfReportedSec: 0 }, MON_15, TZ, 'connected').state).toBe('outside_hours');
    expect(evaluate(eff({ dailyLimitMin: null }), { measuredSec: 0, selfReportedSec: 0 }, MON_15, TZ, 'connected').state).toBe('no_budget');
  });
  it('never claims enforcement without a live extension, and never claims app coverage', () => {
    for (const link of ['never', 'stale', 'unavailable', 'preview'] as const) {
      const e = evaluate(eff(), { measuredSec: 0, selfReportedSec: 0 }, MON_15, TZ, link);
      expect(e.enforcement).toBe('configured_not_enforced');
      expect(e.enforcementNote).toMatch(/not enforced|may not be enforced/);
      expect(e.appsCovered).toBe(false);
    }
    const ok = evaluate(eff(), { measuredSec: 0, selfReportedSec: 0 }, MON_15, TZ, 'connected');
    expect(ok.enforcement).toBe('enforced_in_browser');
    expect(ok.enforcementNote).toMatch(/Apps outside the browser are not covered/);
  });
  it('extension link is derived from the last authenticated request', () => {
    expect(extensionLink(0, MON_15, true)).toBe('never');
    expect(extensionLink(MON_15 - 30_000, MON_15, true)).toBe('connected');
    expect(extensionLink(MON_15 - 600_000, MON_15, true)).toBe('stale');
    expect(extensionLink(MON_15 - 1000, MON_15, false)).toBe('unavailable');
    expect(extensionLink(MON_15 - 1000, MON_15, true, true)).toBe('preview'); // plain browser: never claim enforcement
  });
});

describe('usage aggregation', () => {
  it('only counts the requested day and never merges the two sources', () => {
    const u = aggregateUsage(
      [{ day: '2026-03-02', platform: 'youtube', seconds: 90 }, { day: '2026-03-01', platform: 'youtube', seconds: 999 }],
      [{ day: '2026-03-02', platform: 'youtube', minutes: 2 }],
      '2026-03-02',
    );
    expect(u.youtube).toEqual({ measuredSec: 90, selfReportedSec: 120 });
    expect(aggregateUsage([], [], '2026-03-02')).toEqual({});
  });
});

describe('bridge payload', () => {
  it('carries zone, reset hour, windows and domains; marks class origin', () => {
    const eff = combineRules([personal({ platform: 'youtube', dailyMinutes: 40 })], [klass([rule('youtube', { daily_minutes: 60 })])], MON_15);
    const b = toBridgeRules(eff, BUILTIN_PLATFORMS, { timeZone: 'Asia/Tashkent', resetHour: 4 }, MON_15, 9);
    expect(b).toMatchObject({ revision: 9, day: '2026-03-02', time_zone: 'Asia/Tashkent', reset_hour: 4 });
    expect(b.rules[0]).toMatchObject({ platform: 'youtube', domains: ['youtube.com', 'youtu.be'], daily_limit_minutes: 40, origin: 'class' });
  });
});
