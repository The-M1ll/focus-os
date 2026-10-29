import { addDays, dayKey, dayStartMs, diffDays, formatDuration, isDayKey, isValidZone, minutesOfDay, weekStart, weekday } from './time';

const UTC = { timeZone: 'UTC', resetHour: 0 };

describe('dayKey', () => {
  it('maps instants to the calendar day in the chosen zone', () => {
    const t = Date.UTC(2026, 9, 29, 23, 30); // 23:30 UTC
    expect(dayKey(t, UTC)).toBe('2026-10-29');
    expect(dayKey(t, { timeZone: 'Asia/Tashkent', resetHour: 0 })).toBe('2026-10-30'); // UTC+5
    expect(dayKey(t, { timeZone: 'America/Los_Angeles', resetHour: 0 })).toBe('2026-10-29');
  });

  it('honours the daily reset hour at the boundary', () => {
    const rules = { timeZone: 'UTC', resetHour: 4 };
    expect(dayKey(Date.UTC(2026, 0, 2, 3, 59), rules)).toBe('2026-01-01');
    expect(dayKey(Date.UTC(2026, 0, 2, 4, 0), rules)).toBe('2026-01-02');
  });

  it('is stable across a DST change', () => {
    const rules = { timeZone: 'America/New_York', resetHour: 0 };
    // US DST ended 2026-11-01 (clocks back at 02:00 local)
    expect(dayKey(Date.UTC(2026, 10, 1, 4, 30), rules)).toBe('2026-11-01'); // 00:30 EDT
    expect(dayKey(Date.UTC(2026, 10, 2, 4, 59), rules)).toBe('2026-11-01'); // 23:59 EST
    expect(dayKey(Date.UTC(2026, 10, 2, 5, 0), rules)).toBe('2026-11-02');
  });
});

describe('dayStartMs', () => {
  it('round-trips with dayKey, including DST days', () => {
    for (const tz of ['UTC', 'Asia/Tashkent', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe']) {
      for (const k of ['2026-03-08', '2026-03-29', '2026-10-25', '2026-11-01', '2026-12-31']) {
        const rules = { timeZone: tz, resetHour: 0 };
        const s = dayStartMs(k, rules);
        expect(dayKey(s, rules)).toBe(k);
        expect(dayKey(s - 1, rules)).toBe(addDays(k, -1));
      }
    }
  });
  it('respects reset hour', () => {
    const rules = { timeZone: 'UTC', resetHour: 5 };
    expect(dayStartMs('2026-01-10', rules)).toBe(Date.UTC(2026, 0, 10, 5));
  });
});

describe('day arithmetic', () => {
  it('adds and diffs across month and leap boundaries', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(diffDays('2026-01-01', '2026-12-31')).toBe(364);
  });
  it('validates keys', () => {
    expect(isDayKey('2026-02-30')).toBe(false);
    expect(isDayKey('2026-2-3')).toBe(false);
    expect(isDayKey('2026-12-31')).toBe(true);
  });
  it('computes Monday-based weeks', () => {
    expect(weekday('2026-10-29')).toBe(4); // Thursday
    expect(weekStart('2026-10-29')).toBe('2026-10-26');
    expect(weekStart('2026-11-01')).toBe('2026-10-26'); // Sunday belongs to the week that began Monday
  });
});

describe('misc', () => {
  it('validates time zones', () => {
    expect(isValidZone('Europe/Paris')).toBe(true);
    expect(isValidZone('Mars/Olympus')).toBe(false);
  });
  it('formats durations', () => {
    expect(formatDuration(65_000)).toBe('01:05');
    expect(formatDuration(3_725_000)).toBe('1:02:05');
    expect(formatDuration(-5)).toBe('00:00');
  });
  it('minutes of day uses zone', () => {
    expect(minutesOfDay(Date.UTC(2026, 0, 1, 20, 15), 'Asia/Tashkent')).toBe(60 + 15); // 01:15
  });
});
