/**
 * Pure logic for the FOCUS OS browser extension: which platform a URL belongs to, how much
 * foreground time to credit, and whether access should currently be allowed. No `chrome.*`
 * calls here, so it is fully unit-tested. Availability and day-boundary rules are shared with
 * the desktop app (src/domain) so both sides always agree.
 */
import { isAvailableAt, type Window } from '../../src/domain/limits';
import { dayKey } from '../../src/domain/time';

export interface Rule {
  platform: string;
  domains: string[];
  daily_limit_minutes: number | null;
  blocked: boolean;
  self_reported_minutes: number;
  allowed_windows: Window[];
  origin: string;
}

export interface Rules {
  revision: number;
  day: string;
  time_zone: string;
  reset_hour: number;
  rules: Rule[];
}

/** hostname -> platform id, matching the domain itself or any subdomain. */
export function platformForUrl(url: string, rules: Rule[]): Rule | null {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    host = u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  for (const r of rules) {
    for (const d of r.domains) {
      if (host === d || host.endsWith('.' + d)) return r;
    }
  }
  return null;
}

/** Longest gap credited between two observations, so a suspended service worker can't invent time. */
export const MAX_CREDIT_SEC = 45;

export interface Observation {
  /** Epoch ms of this observation. */
  at: number;
  /** Is a browser window focused, with a matching tab active, and the user not idle? */
  engaged: boolean;
  platform: string | null;
}

export interface TrackerState {
  last: { at: number; engaged: boolean; platform: string | null } | null;
}

export interface Credit {
  platform: string;
  seconds: number;
  day: string;
}

/**
 * Credits foreground seconds to the platform that was engaged during the *previous* interval.
 * Only whole seconds, capped at MAX_CREDIT_SEC per interval; a backwards clock jump credits nothing.
 */
export function observe(state: TrackerState, obs: Observation, dayRules: { timeZone: string; resetHour: number }): { state: TrackerState; credit: Credit | null } {
  const prev = state.last;
  const next: TrackerState = { last: { at: obs.at, engaged: obs.engaged, platform: obs.platform } };
  if (!prev || !prev.engaged || !prev.platform) return { state: next, credit: null };
  const gap = (obs.at - prev.at) / 1000;
  if (!(gap > 0)) return { state: next, credit: null };
  const seconds = Math.floor(Math.min(gap, MAX_CREDIT_SEC));
  if (seconds <= 0) return { state: next, credit: null };
  // The interval belongs to the day in which it started, which is what a student expects at midnight.
  return { state: next, credit: { platform: prev.platform, seconds, day: dayKey(prev.at, dayRules) } };
}

export type Decision = { allow: true } | { allow: false; reason: 'blocked' | 'outside_hours' | 'budget' };

export function decide(rule: Rule, measuredSecToday: number, now: number, timeZone: string): Decision {
  if (rule.blocked) return { allow: false, reason: 'blocked' };
  if (!isAvailableAt(rule.allowed_windows, now, timeZone)) return { allow: false, reason: 'outside_hours' };
  if (rule.daily_limit_minutes !== null) {
    const usedMin = measuredSecToday / 60 + rule.self_reported_minutes;
    if (usedMin >= rule.daily_limit_minutes) return { allow: false, reason: 'budget' };
  }
  return { allow: true };
}

/** Pending usage waiting to be sent to the app, merged per (day, platform) and chunked to the bridge limit. */
export function mergePending(pending: Credit[], add: Credit | null): Credit[] {
  if (!add) return pending;
  const out = pending.map((c) => ({ ...c }));
  const hit = out.find((c) => c.day === add.day && c.platform === add.platform);
  if (hit) hit.seconds += add.seconds;
  else out.push({ ...add });
  return out;
}

export function chunkForUpload(pending: Credit[], maxPer = 3600): Credit[] {
  const out: Credit[] = [];
  for (const c of pending) {
    let left = c.seconds;
    while (left > 0) {
      const part = Math.min(left, maxPer);
      out.push({ ...c, seconds: part });
      left -= part;
    }
  }
  return out;
}

export function redirectRuleId(platform: string, i: number): number {
  let h = 7;
  for (const ch of platform) h = (h * 31 + ch.charCodeAt(0)) % 100000;
  return 1000 + h * 10 + (i % 10);
}
