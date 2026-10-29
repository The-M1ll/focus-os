/**
 * Desktop-app limits: naming, the rule shape sent to the native app monitor, and honest status text.
 *
 * An app rule is an ordinary limit rule whose platform id is `app.<slug>`, so it travels through class
 * policy, precedence (strictest class rule wins, personal can only tighten) and storage unchanged.
 * The native monitor measures how long the app is OPEN (not how long its window is focused) and,
 * when a limit is reached, warns and then closes it. See ARCHITECTURE.md §Apps.
 */

import { type DayRules, dayKey } from './time';
import { type EffectiveRule, type Window, isAvailableAt } from './limits';

export const APP_PREFIX = 'app.';

/** Must stay identical to `focus_core::apps::slug` (covered by tests on both sides). */
export function appSlug(name: string): string {
  const lower = name.trim().toLowerCase();
  let stem = lower;
  for (const ext of ['exe', 'app', 'bin', 'desktop']) {
    if (lower.endsWith(`.${ext}`)) {
      stem = lower.slice(0, -(ext.length + 1));
      break;
    }
  }
  const out = stem.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out.slice(0, 56).replace(/-+$/g, '');
}

export const appRuleId = (slug: string) => APP_PREFIX + slug;
export const isAppRule = (platform: string) => platform.startsWith(APP_PREFIX) && platform.length > APP_PREFIX.length;
export const appSlugOf = (platform: string) => platform.slice(APP_PREFIX.length);

export interface KnownApp {
  slug: string;
  name: string;
  game: boolean;
}

/** Mirrors `focus_core::apps::KNOWN` (names only; the process aliases live in Rust). */
export const KNOWN_APPS: KnownApp[] = [
  { slug: 'steam', name: 'Steam', game: true },
  { slug: 'epic-games-launcher', name: 'Epic Games Launcher', game: true },
  { slug: 'roblox', name: 'Roblox', game: true },
  { slug: 'minecraft-launcher', name: 'Minecraft Launcher', game: true },
  { slug: 'fortnite', name: 'Fortnite', game: true },
  { slug: 'valorant', name: 'Valorant', game: true },
  { slug: 'league-of-legends', name: 'League of Legends', game: true },
  { slug: 'counter-strike-2', name: 'Counter-Strike 2', game: true },
  { slug: 'dota-2', name: 'Dota 2', game: true },
  { slug: 'genshin-impact', name: 'Genshin Impact', game: true },
  { slug: 'battle-net', name: 'Battle.net', game: true },
  { slug: 'discord', name: 'Discord', game: false },
  { slug: 'spotify', name: 'Spotify', game: false },
];

export function appDisplayName(slug: string): string {
  const k = KNOWN_APPS.find((a) => a.slug === slug);
  if (k) return k.name;
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}

/** Name for any rule id: apps get their app name, everything else is looked up by the caller. */
export const ruleName = (platform: string, fallback: (id: string) => string) => (isAppRule(platform) ? appDisplayName(appSlugOf(platform)) : fallback(platform));

// ---- native enforcement mode (a per-device setting) -----------------------------------------------

export type AppMode = 'close' | 'remind' | 'off';

export const MODE_TEXT: Record<AppMode, { title: string; detail: string }> = {
  close: { title: 'Warn, then close', detail: 'When a limit is reached you get a warning. If the app is still open after it, FOCUS OS asks it to close, and ends it if it does not.' },
  remind: { title: 'Remind only', detail: 'You get warnings, but FOCUS OS never closes anything. Time is still counted.' },
  off: { title: 'Off', detail: 'App time is counted but nothing is warned or closed. Class app rules show as not enforced on this computer.' },
};

// ---- availability ---------------------------------------------------------------------------------

/** First moment (ms) at or after `now` when the app stops being allowed; `null` if that is not within 36 h or there are no hours rules. */
export function availableUntil(windows: Window[], now: number, tz: string): number | null {
  if (windows.length === 0 || !isAvailableAt(windows, now, tz)) return null;
  const COARSE = 5 * 60_000;
  const horizon = now + 36 * 3_600_000;
  for (let t = now; t < horizon; t += COARSE) {
    const next = t + COARSE;
    if (!isAvailableAt(windows, next, tz)) {
      for (let m = t + 60_000; m <= next; m += 60_000) if (!isAvailableAt(windows, m, tz)) return m;
      return next;
    }
  }
  return null;
}

// ---- policy pushed to the native monitor ---------------------------------------------------------

export interface AppRulePush {
  slug: string;
  label: string;
  blocked_now: boolean;
  why: string;
  budget_secs: number | null;
  extra_used_secs: number;
  allowed_until_ms: number | null;
}

export interface AppsPolicyPush {
  day: string;
  mode: AppMode;
  rules: AppRulePush[];
}

export function whyBlocked(e: EffectiveRule, availableNow: boolean): string {
  const fromClass = e.origins.find((o) => o.origin === 'class');
  if (e.blocked) return fromClass ? `Blocked by your class (${fromClass.label.replace(/ \(revision \d+\)$/, '')}).` : 'You blocked this app.';
  if (!availableNow) return 'It is outside the hours this app is allowed.';
  return 'Your time for this app is used up.';
}

export function toAppsPolicy(effective: EffectiveRule[], rules: DayRules, now: number, mode: AppMode, selfReportedMin: Record<string, number> = {}): AppsPolicyPush {
  const out: AppRulePush[] = [];
  for (const e of effective) {
    if (!isAppRule(e.platform) || e.origins.length === 0) continue; // nothing in force (e.g. a switched-off personal rule)
    const slug = appSlugOf(e.platform);
    const availableNow = !e.blocked && isAvailableAt(e.windows, now, rules.timeZone);
    out.push({
      slug,
      label: appDisplayName(slug),
      blocked_now: !availableNow,
      why: whyBlocked(e, availableNow),
      budget_secs: e.dailyLimitMin === null ? null : Math.round(e.dailyLimitMin * 60),
      extra_used_secs: Math.round((selfReportedMin[e.platform] ?? 0) * 60),
      allowed_until_ms: availableNow ? availableUntil(e.windows, now, rules.timeZone) : null,
    });
  }
  return { day: dayKey(now, rules), mode, rules: out };
}

// ---- honest status ---------------------------------------------------------------------------------

export type AppsLink = 'active' | 'off' | 'preview' | 'unavailable';

export function appsLink(native: boolean, mode: AppMode, statusOk: boolean): AppsLink {
  if (!native) return 'preview';
  if (!statusOk) return 'unavailable';
  return mode === 'off' ? 'off' : 'active';
}

export const APPS_LINK_TEXT: Record<AppsLink, { pill: string; note: string }> = {
  active: { pill: 'Watching this computer', note: 'FOCUS OS checks every few seconds which of your limited apps are open. It counts open time and acts on the rules below.' },
  off: { pill: 'Enforcement off', note: 'Time is counted, but nothing is warned or closed. Change this in “How limits are enforced”.' },
  preview: { pill: 'Desktop app only', note: 'You are in the browser preview. Finding, timing and closing apps needs the FOCUS OS desktop app; rules are saved here but nothing is enforced.' },
  unavailable: { pill: 'Monitor not responding', note: 'The desktop app could not report on this computer’s apps, so nothing is being enforced.' },
};
