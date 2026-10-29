/**
 * Digital-life limits: rule precedence, availability windows, usage evaluation and the
 * honest status of enforcement.
 *
 * Precedence (documented in ARCHITECTURE.md):
 *   1. Application safety/integrity (nothing here can disable the app's own safeguards).
 *   2. Authorised class rules - the strictest class rule wins per platform.
 *   3. Personal rules - only when EVERY joined class allows them, and they can only
 *      tighten, never loosen, a class rule.
 *   4. App defaults (no restriction).
 *
 * Usage is never invented: "measured" comes from an integration (browser extension),
 * "self-reported" is typed in by the student. They are kept apart and shown apart.
 */

import { type DayRules, dayKey, minutesOfDay, weekdayAt } from './time';
import type { CustomPlatform, PersonalLimit } from './schemas';

export interface Window {
  days: number[]; // 0 = Sunday; empty = every day
  start_min: number;
  end_min: number;
}

/** Shape published by the classroom host (snake_case, mirrors Rust). */
export interface ClassRule {
  platform: string;
  blocked: boolean;
  daily_minutes: number | null;
  allowed_windows: Window[];
}

export interface ClassPolicyView {
  classId: string;
  className: string;
  revision: number;
  receivedAt: number;
  limits: ClassRule[];
  allowPersonalLimits: boolean;
}

export interface PlatformDef {
  id: string;
  name: string;
  domains: string[];
  builtin: boolean;
}

export const BUILTIN_PLATFORMS: PlatformDef[] = [
  { id: 'instagram', name: 'Instagram', domains: ['instagram.com'], builtin: true },
  { id: 'tiktok', name: 'TikTok', domains: ['tiktok.com'], builtin: true },
  { id: 'youtube', name: 'YouTube', domains: ['youtube.com', 'youtu.be'], builtin: true },
  { id: 'telegram', name: 'Telegram', domains: ['web.telegram.org', 't.me'], builtin: true },
  { id: 'discord', name: 'Discord', domains: ['discord.com'], builtin: true },
  { id: 'reddit', name: 'Reddit', domains: ['reddit.com'], builtin: true },
];

export function allPlatforms(custom: CustomPlatform[]): PlatformDef[] {
  return [...BUILTIN_PLATFORMS, ...custom.map((c) => ({ id: c.id, name: c.name, domains: c.domains, builtin: false }))];
}

// ---- availability windows ---------------------------------------------------

type Interval = [number, number];

/** Per-weekday list of allowed intervals; `null` = unrestricted. */
type Availability = Interval[][] | null;

function toAvailability(windows: Window[]): Availability {
  if (windows.length === 0) return null;
  const week: Interval[][] = Array.from({ length: 7 }, () => []);
  for (const w of windows) {
    const days = w.days.length ? w.days : [0, 1, 2, 3, 4, 5, 6];
    for (const d of days) week[d]!.push([w.start_min, w.end_min]);
  }
  return week.map(merge);
}

function merge(iv: Interval[]): Interval[] {
  const s = [...iv].sort((a, b) => a[0] - b[0]);
  const out: Interval[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function intersect(a: Availability, b: Availability): Availability {
  if (!a) return b;
  if (!b) return a;
  return a.map((ia, d) => {
    const out: Interval[] = [];
    for (const [s1, e1] of ia) for (const [s2, e2] of b[d]!) {
      const s = Math.max(s1, s2);
      const e = Math.min(e1, e2);
      if (s < e) out.push([s, e]);
    }
    return merge(out);
  });
}

function availabilityToWindows(av: Availability): Window[] {
  if (!av) return [];
  const out: Window[] = [];
  const key = (iv: Interval[]) => JSON.stringify(iv);
  const groups = new Map<string, { iv: Interval[]; days: number[] }>();
  av.forEach((iv, d) => {
    const k = key(iv);
    const g = groups.get(k) ?? { iv, days: [] };
    g.days.push(d);
    groups.set(k, g);
  });
  for (const g of groups.values()) for (const [s, e] of g.iv) out.push({ days: g.days.length === 7 ? [] : g.days, start_min: s, end_min: e });
  return out;
}

export function isAvailableAt(windows: Window[], ms: number, tz: string): boolean {
  const av = toAvailability(windows);
  if (!av) return true;
  const mins = minutesOfDay(ms, tz);
  return av[weekdayAt(ms, tz)]!.some(([s, e]) => mins >= s && mins < e);
}

/** Human description of the next time the platform opens up (null = never within a week or unrestricted). */
export function nextOpening(windows: Window[], ms: number, tz: string): number | null {
  const av = toAvailability(windows);
  if (!av) return null;
  const step = 60_000;
  for (let t = ms; t < ms + 8 * 86_400_000; t += step * 5) if (isAvailableAt(windows, t, tz)) return t;
  return null;
}

// ---- effective rules --------------------------------------------------------

export interface RuleOrigin {
  origin: 'class' | 'personal';
  label: string;
}

export interface EffectiveRule {
  platform: string;
  blocked: boolean;
  dailyLimitMin: number | null;
  windows: Window[];
  origins: RuleOrigin[];
  /** A personal rule that exists but is not in force, with the reason shown to the student. */
  inactivePersonal?: string;
}

function personalToWindows(p: PersonalLimit): Window[] {
  const allDays = p.days.length === 7 || p.days.length === 0;
  const hasTimes = p.allowedStart !== null && p.allowedEnd !== null;
  if (allDays && !hasTimes) return [];
  return [{ days: allDays ? [] : p.days, start_min: hasTimes ? p.allowedStart! : 0, end_min: hasTimes ? p.allowedEnd! : 1440 }];
}

export function combineRules(personal: PersonalLimit[], policies: ClassPolicyView[], now: number): EffectiveRule[] {
  const platforms = new Set<string>([...personal.map((p) => p.platform), ...policies.flatMap((c) => c.limits.map((l) => l.platform))]);
  const personalAllowed = policies.every((c) => c.allowPersonalLimits);
  const out: EffectiveRule[] = [];
  for (const platform of [...platforms].sort()) {
    const origins: RuleOrigin[] = [];
    let blocked = false;
    let limit: number | null = null;
    let av: Availability = null;
    for (const c of policies) {
      const r = c.limits.find((l) => l.platform === platform);
      if (!r) continue;
      origins.push({ origin: 'class', label: `${c.className} (revision ${c.revision})` });
      if (r.blocked) blocked = true;
      if (r.daily_minutes !== null) limit = limit === null ? r.daily_minutes : Math.min(limit, r.daily_minutes);
      av = intersect(av, toAvailability(r.allowed_windows));
    }
    let inactivePersonal: string | undefined;
    const p = personal.find((x) => x.platform === platform);
    if (p) {
      const paused = p.pausedUntil !== undefined && p.pausedUntil > now;
      if (!p.enabled) inactivePersonal = 'Switched off';
      else if (!personalAllowed) inactivePersonal = 'Your class does not allow personal limits right now';
      else if (paused) inactivePersonal = 'Paused';
      else {
        origins.push({ origin: 'personal', label: 'Your own rule' });
        if (p.dailyMinutes !== null) limit = limit === null ? p.dailyMinutes : Math.min(limit, p.dailyMinutes);
        av = intersect(av, toAvailability(personalToWindows(p)));
      }
    }
    if (origins.length === 0 && !inactivePersonal) continue;
    out.push({ platform, blocked, dailyLimitMin: blocked ? null : limit, windows: blocked ? [] : availabilityToWindows(av), origins, inactivePersonal });
  }
  return out;
}

// ---- usage and status -------------------------------------------------------

export interface UsageDay {
  measuredSec: number;
  selfReportedSec: number;
}

export type LimitState = 'ok' | 'warning' | 'exhausted' | 'outside_hours' | 'blocked' | 'no_budget';
export type Enforcement = 'enforced_in_browser' | 'configured_not_enforced';
export type ExtensionLink = 'connected' | 'stale' | 'never' | 'unavailable' | 'preview';

export interface Evaluation {
  state: LimitState;
  measuredMin: number;
  selfReportedMin: number;
  usedMin: number;
  remainingMin: number | null;
  limitMin: number | null;
  availableNow: boolean;
  enforcement: Enforcement;
  /** Why enforcement is (not) active, in plain words. */
  enforcementNote: string;
  /** Apps outside the browser are never covered in this version. */
  appsCovered: false;
}

/** `preview` = running in a plain browser: there is no desktop bridge to ask, so nothing can be enforced. */
export function extensionLink(lastSeenMs: number, now: number, bridgeUp: boolean, preview = false): ExtensionLink {
  if (preview) return 'preview';
  if (!bridgeUp) return 'unavailable';
  if (lastSeenMs <= 0) return 'never';
  return now - lastSeenMs <= 2 * 60_000 ? 'connected' : 'stale';
}

export function enforcementFor(link: ExtensionLink): { enforcement: Enforcement; note: string } {
  switch (link) {
    case 'connected':
      return { enforcement: 'enforced_in_browser', note: 'Enforced in your browser by the FOCUS OS extension. Apps outside the browser are not covered.' };
    case 'stale':
      return { enforcement: 'configured_not_enforced', note: 'The browser extension has not checked in for a while, so this rule may not be enforced right now.' };
    case 'never':
      return { enforcement: 'configured_not_enforced', note: 'Configured, but not enforced: the browser extension is not installed or not connected.' };
    case 'unavailable':
      return { enforcement: 'configured_not_enforced', note: 'Configured, but not enforced: the local bridge for the extension could not start.' };
    case 'preview':
      return { enforcement: 'configured_not_enforced', note: 'Configured, but not enforced: enforcement needs the FOCUS OS desktop app and its browser extension.' };
  }
}

export function evaluate(rule: EffectiveRule, usage: UsageDay, now: number, tz: string, link: ExtensionLink, warnAtPct = 80): Evaluation {
  const measuredMin = usage.measuredSec / 60;
  const selfReportedMin = usage.selfReportedSec / 60;
  const usedMin = measuredMin + selfReportedMin;
  const availableNow = !rule.blocked && isAvailableAt(rule.windows, now, tz);
  const { enforcement, note } = enforcementFor(link);
  const base = { measuredMin, selfReportedMin, usedMin, limitMin: rule.dailyLimitMin, availableNow, enforcement, enforcementNote: note, appsCovered: false as const };
  if (rule.blocked) return { ...base, state: 'blocked', remainingMin: 0 };
  if (!availableNow) return { ...base, state: 'outside_hours', remainingMin: rule.dailyLimitMin === null ? null : Math.max(0, rule.dailyLimitMin - usedMin) };
  if (rule.dailyLimitMin === null) return { ...base, state: 'no_budget', remainingMin: null };
  const remaining = Math.max(0, rule.dailyLimitMin - usedMin);
  if (usedMin >= rule.dailyLimitMin) return { ...base, state: 'exhausted', remainingMin: 0 };
  const warn = rule.dailyLimitMin > 0 && usedMin >= (rule.dailyLimitMin * warnAtPct) / 100;
  return { ...base, state: warn ? 'warning' : 'ok', remainingMin: remaining };
}

export function aggregateUsage(
  measured: { day: string; platform: string; seconds: number }[],
  manual: { day: string; platform: string; minutes: number }[],
  day: string,
): Record<string, UsageDay> {
  const out: Record<string, UsageDay> = {};
  for (const m of measured) if (m.day === day) (out[m.platform] ??= { measuredSec: 0, selfReportedSec: 0 }).measuredSec += m.seconds;
  for (const m of manual) if (m.day === day) (out[m.platform] ??= { measuredSec: 0, selfReportedSec: 0 }).selfReportedSec += m.minutes * 60;
  return out;
}

/** Rules in the form the browser extension consumes (it evaluates windows itself, in the given zone). */
export function toBridgeRules(effective: EffectiveRule[], platforms: PlatformDef[], rules: DayRules, now: number, revision: number, selfReportedMin: Record<string, number> = {}) {
  return {
    revision,
    day: dayKey(now, rules),
    time_zone: rules.timeZone,
    reset_hour: rules.resetHour,
    rules: effective.map((r) => ({
      platform: r.platform,
      domains: platforms.find((p) => p.id === r.platform)?.domains ?? [r.platform],
      daily_limit_minutes: r.dailyLimitMin,
      blocked: r.blocked,
      self_reported_minutes: Math.round(selfReportedMin[r.platform] ?? 0),
      allowed_windows: r.windows,
      origin: r.origins.some((o) => o.origin === 'class') ? 'class' : 'personal',
    })),
  };
}

