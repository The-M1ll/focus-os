import { appDisplayName, appRuleId, appSlug, appSlugOf, appsLink, availableUntil, isAppRule, KNOWN_APPS, toAppsPolicy } from './apps';
import { combineRules, toBridgeRules, type ClassPolicyView, type Window } from './limits';
import type { PersonalLimit } from './schemas';

const RULES = { timeZone: 'UTC', resetHour: 4 };
const MON_15 = Date.UTC(2026, 2, 2, 15, 0);
const personal = (o: Partial<PersonalLimit> = {}): PersonalLimit => ({ id: 'p', platform: 'app.roblox', dailyMinutes: 45, days: [0, 1, 2, 3, 4, 5, 6], allowedStart: null, allowedEnd: null, warnAtPct: 80, enabled: true, createdAt: 0, ...o });
const klass = (limits: ClassPolicyView['limits'], o: Partial<ClassPolicyView> = {}): ClassPolicyView => ({ classId: 'c1', className: '10B', revision: 4, receivedAt: 0, limits, allowPersonalLimits: true, ...o });

describe('app ids (must match focus_core::apps::slug)', () => {
  it('slugs names the same way the native side does', () => {
    expect(appSlug('Epic Games Launcher.exe')).toBe('epic-games-launcher');
    expect(appSlug('Battle.net.exe')).toBe('battle-net');
    expect(appSlug('Minecraft Launcher')).toBe('minecraft-launcher');
    expect(appSlug('  Steam.app ')).toBe('steam');
    expect(appSlug('...')).toBe('');
    expect(appSlug('Genshin   Impact')).toBe('genshin-impact');
  });
  it('round-trips rule ids and names', () => {
    expect(appRuleId('roblox')).toBe('app.roblox');
    expect(isAppRule('app.roblox')).toBe(true);
    expect(isAppRule('youtube')).toBe(false);
    expect(isAppRule('app.')).toBe(false);
    expect(appSlugOf('app.minecraft-launcher')).toBe('minecraft-launcher');
    expect(appDisplayName('minecraft-launcher')).toBe('Minecraft Launcher');
    expect(appDisplayName('some-cool-game')).toBe('Some Cool Game');
    for (const k of KNOWN_APPS) expect(appSlug(k.name)).toBe(k.slug); // catalogue names produce their own slugs
  });
  it('rule ids fit the class policy platform alphabet and length', () => {
    for (const k of KNOWN_APPS) expect(appRuleId(k.slug)).toMatch(/^[a-z0-9.-]{1,64}$/);
    expect(appRuleId('x'.repeat(56)).length).toBeLessThanOrEqual(64);
  });
});

describe('availableUntil', () => {
  const afternoon: Window[] = [{ days: [], start_min: 14 * 60, end_min: 17 * 60 }];
  it('is the end of the current allowed window', () => {
    expect(availableUntil(afternoon, MON_15, 'UTC')).toBe(Date.UTC(2026, 2, 2, 17, 0));
  });
  it('is null when there are no hours rules or the app is not allowed now', () => {
    expect(availableUntil([], MON_15, 'UTC')).toBeNull();
    expect(availableUntil(afternoon, Date.UTC(2026, 2, 2, 18, 0), 'UTC')).toBeNull();
  });
  it('uses the configured zone', () => {
    // 15:00 UTC is 20:00 in Tashkent; a 19:00-21:00 window ends at 16:00 UTC.
    const w: Window[] = [{ days: [], start_min: 19 * 60, end_min: 21 * 60 }];
    expect(availableUntil(w, MON_15, 'Asia/Tashkent')).toBe(Date.UTC(2026, 2, 2, 16, 0));
  });
  it('does not cut an allowed window that continues past midnight across days', () => {
    const allDay: Window[] = [{ days: [], start_min: 0, end_min: 1440 }];
    expect(availableUntil(allDay, MON_15, 'UTC')).toBeNull();
  });
});

describe('policy pushed to the native monitor', () => {
  it('turns a personal budget into seconds and ignores websites', () => {
    const eff = combineRules([personal(), personal({ id: 'w', platform: 'youtube' })], [], MON_15);
    const p = toAppsPolicy(eff, RULES, MON_15, 'close');
    expect(p.mode).toBe('close');
    expect(p.day).toBe('2026-03-02');
    expect(p.rules).toHaveLength(1);
    expect(p.rules[0]).toMatchObject({ slug: 'roblox', label: 'Roblox', blocked_now: false, budget_secs: 2700, allowed_until_ms: null });
  });
  it('a class block wins, says so, and cannot be loosened by a personal rule', () => {
    const eff = combineRules([personal({ platform: 'app.minecraft-launcher', dailyMinutes: 600 })], [klass([{ platform: 'app.minecraft-launcher', blocked: true, daily_minutes: null, allowed_windows: [] }])], MON_15);
    const r = toAppsPolicy(eff, RULES, MON_15, 'close').rules[0]!;
    expect(r.blocked_now).toBe(true);
    expect(r.why).toBe('Blocked by your class (10B).');
    expect(r.budget_secs).toBeNull();
  });
  it('the strictest budget wins between class and personal', () => {
    const eff = combineRules([personal({ dailyMinutes: 30 })], [klass([{ platform: 'app.roblox', blocked: false, daily_minutes: 60, allowed_windows: [] }])], MON_15);
    expect(toAppsPolicy(eff, RULES, MON_15, 'remind').rules[0]!.budget_secs).toBe(1800);
    const eff2 = combineRules([personal({ dailyMinutes: 90 })], [klass([{ platform: 'app.roblox', blocked: false, daily_minutes: 60, allowed_windows: [] }])], MON_15);
    expect(toAppsPolicy(eff2, RULES, MON_15, 'remind').rules[0]!.budget_secs).toBe(3600);
  });
  it('outside class hours the app is blocked now; inside them it has an end time', () => {
    const hours = klass([{ platform: 'app.roblox', blocked: false, daily_minutes: null, allowed_windows: [{ days: [], start_min: 16 * 60, end_min: 18 * 60 }] }]);
    const out = toAppsPolicy(combineRules([], [hours], MON_15), RULES, MON_15, 'close').rules[0]!;
    expect(out).toMatchObject({ blocked_now: true, why: 'It is outside the hours this app is allowed.' });
    const t = Date.UTC(2026, 2, 2, 16, 30);
    const inside = toAppsPolicy(combineRules([], [hours], t), RULES, t, 'close').rules[0]!;
    expect(inside).toMatchObject({ blocked_now: false, allowed_until_ms: Date.UTC(2026, 2, 2, 18, 0) });
  });
  it('a paused or switched-off personal rule sends nothing', () => {
    expect(toAppsPolicy(combineRules([personal({ enabled: false })], [], MON_15), RULES, MON_15, 'close').rules).toEqual([]);
    expect(toAppsPolicy(combineRules([personal({ pausedUntil: MON_15 + 3_600_000 })], [], MON_15), RULES, MON_15, 'close').rules).toEqual([]);
  });
  it('the browser extension never receives app rules', () => {
    const eff = combineRules([personal(), personal({ id: 'w', platform: 'youtube' })], [], MON_15);
    const b = toBridgeRules(eff, [{ id: 'youtube', name: 'YouTube', domains: ['youtube.com'], builtin: true }], RULES, MON_15, 1);
    expect(b.rules.map((r) => r.platform)).toEqual(['youtube']);
  });
});

describe('honest status', () => {
  it('only claims to be watching when the desktop app answers and enforcement is not off', () => {
    expect(appsLink(false, 'close', false)).toBe('preview');
    expect(appsLink(true, 'close', false)).toBe('unavailable');
    expect(appsLink(true, 'off', true)).toBe('off');
    expect(appsLink(true, 'close', true)).toBe('active');
    expect(appsLink(true, 'remind', true)).toBe('active');
  });
});
