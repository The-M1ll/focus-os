/**
 * Day arithmetic that is explicit about the time zone and the "study day" boundary.
 * A day key is 'YYYY-MM-DD' in the chosen zone, shifted by `resetHour` (e.g. 4 means
 * 03:59 still belongs to the previous day). Everything is pure and testable.
 */

export interface DayRules {
  timeZone: string; // IANA, e.g. 'Asia/Tashkent'
  resetHour: number; // 0..23
}

export const SYSTEM_ZONE = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface Parts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

export function partsInZone(ms: number, tz: string): Parts {
  const o: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') o[p.type] = Number(p.value);
  }
  return { y: o.year!, m: o.month!, d: o.day!, hh: o.hour!, mm: o.minute!, ss: o.second! };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const keyOf = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

/** Timestamp -> 'YYYY-MM-DD' study-day key. */
export function dayKey(ms: number, rules: DayRules): string {
  const p = partsInZone(ms, rules.timeZone);
  // Shifting the wall-clock back by resetHour hours and re-reading the date is exact
  // because we only need the calendar date of the shifted wall time.
  const shifted = Date.UTC(p.y, p.m - 1, p.d, p.hh - rules.resetHour, p.mm, p.ss);
  const s = new Date(shifted);
  return keyOf(s.getUTCFullYear(), s.getUTCMonth() + 1, s.getUTCDate());
}

export function parseKey(k: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k);
  if (!m) throw new Error(`bad day key: ${k}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function isDayKey(k: unknown): k is string {
  if (typeof k !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
  const { y, m, d } = parseKey(k);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function addDays(k: string, n: number): string {
  const { y, m, d } = parseKey(k);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return keyOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Whole days from a to b (b - a). */
export function diffDays(a: string, b: string): number {
  const pa = parseKey(a);
  const pb = parseKey(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

/** 0 = Sunday .. 6 = Saturday for a day key. */
export function weekday(k: string): number {
  const { y, m, d } = parseKey(k);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Monday-based week start for a day key. */
export function weekStart(k: string): string {
  const wd = weekday(k);
  return addDays(k, -((wd + 6) % 7));
}

export function rangeDays(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(from, i));
}

/**
 * Epoch ms for local midnight (00:00 wall time + resetHour) of a day key in a zone.
 * Resolved by search so DST gaps/overlaps are handled by the platform's own tz database.
 */
export function dayStartMs(k: string, rules: DayRules): number {
  const { y, m, d } = parseKey(k);
  const target = Date.UTC(y, m - 1, d, rules.resetHour, 0, 0);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = partsInZone(guess, rules.timeZone);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
    const diff = target - asUtc;
    if (diff === 0) return guess;
    guess += diff;
  }
  return guess;
}

/** Minutes since local wall midnight (not study-day shifted) – used for time-of-day windows. */
export function minutesOfDay(ms: number, tz: string): number {
  const p = partsInZone(ms, tz);
  return p.hh * 60 + p.mm;
}

/** Wall-clock weekday (0=Sun) in zone at an instant. */
export function weekdayAt(ms: number, tz: string): number {
  const p = partsInZone(ms, tz);
  return weekday(keyOf(p.y, p.m, p.d));
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const r = Math.round(min % 60);
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}
