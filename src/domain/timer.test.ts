import { GAP_MS, extend, finalize, minutesByDay, pause, recover, remainingMs, resume, start, tick, activeMs } from './timer';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 10, 0, 0);
const mk = (planned = 25 * MIN) => start({ id: 't1', kind: 'focus', plannedMs: planned }, T0);

/** Tick every 5 s until `until`, like the real heartbeat. */
function run(t: ReturnType<typeof mk>, until: number, step = 5_000) {
  let cur = t;
  for (let now = t.lastHeartbeat + step; now <= until; now += step) cur = tick(cur, now);
  return cur;
}

describe('running, pausing, resuming', () => {
  it('counts only active time', () => {
    let t = run(mk(), T0 + 10 * MIN);
    expect(activeMs(t)).toBe(10 * MIN);
    t = pause(t, T0 + 10 * MIN);
    expect(t.status).toBe('paused');
    expect(t.pauseReason).toBe('user');
    // 30 minutes pass while paused
    t = resume(t, T0 + 40 * MIN);
    t = run(t, T0 + 45 * MIN);
    expect(activeMs(t)).toBe(15 * MIN);
    expect(remainingMs(t)).toBe(10 * MIN);
  });

  it('pausing a paused timer or resuming a running one is a no-op', () => {
    const t = pause(run(mk(), T0 + MIN), T0 + MIN);
    expect(pause(t, T0 + 2 * MIN)).toBe(t);
    const r = mk();
    expect(resume(r, T0 + 1)).toBe(r);
  });

  it('finishes exactly at the planned time and never over-records', () => {
    const t = run(mk(2 * MIN), T0 + 3 * MIN);
    expect(t.status).toBe('finished');
    expect(activeMs(t)).toBe(2 * MIN);
    const rec = finalize(t, T0 + 3 * MIN);
    expect(rec.outcome).toBe('completed');
    expect(rec.activeMs).toBe(2 * MIN);
  });

  it('a late tick right at completion trims overshoot', () => {
    let t = run(mk(MIN), T0 + 55_000);
    t = tick(t, T0 + 80_000); // 25 s late but < GAP
    expect(t.status).toBe('finished');
    expect(activeMs(t)).toBe(MIN);
  });

  it('extending a finished timer continues it', () => {
    let t = run(mk(MIN), T0 + 2 * MIN);
    t = extend(t, 5 * MIN, T0 + 2 * MIN);
    expect(t.status).toBe('running');
    t = run(t, T0 + 4 * MIN);
    expect(activeMs(t)).toBe(MIN + 2 * MIN);
  });
});

describe('sleep, suspension and clock changes', () => {
  it('does not count system sleep as focus time', () => {
    let t = run(mk(), T0 + 5 * MIN);
    // laptop lid closed for 2 hours; first tick after wake
    t = tick(t, T0 + 5 * MIN + 120 * MIN);
    expect(t.status).toBe('paused');
    expect(t.pauseReason).toBe('interrupted');
    expect(activeMs(t)).toBe(5 * MIN);
  });

  it('a gap just under the threshold is treated as throttling, not sleep', () => {
    let t = run(mk(), T0 + MIN);
    t = tick(t, T0 + MIN + GAP_MS);
    expect(t.status).toBe('running');
    expect(activeMs(t)).toBe(MIN + GAP_MS);
  });

  it('a backwards wall-clock jump never produces negative time', () => {
    let t = run(mk(), T0 + 10 * MIN);
    t = tick(t, T0 + 2 * MIN);
    expect(activeMs(t)).toBe(10 * MIN); // nothing already counted is lost
    t = run(t, T0 + 3 * MIN);
    expect(activeMs(t)).toBe(11 * MIN); // and counting continues from the new clock
  });

  it('user can resume an interrupted session; the gap stays excluded', () => {
    let t = run(mk(), T0 + 5 * MIN);
    t = tick(t, T0 + 65 * MIN);
    t = resume(t, T0 + 66 * MIN);
    t = run(t, T0 + 71 * MIN);
    expect(activeMs(t)).toBe(10 * MIN);
  });
});

describe('recovery after restart', () => {
  it('a running timer found after a long absence becomes interrupted at its last heartbeat', () => {
    const t = run(mk(), T0 + 7 * MIN);
    const r = recover(t, T0 + 3 * 60 * MIN);
    expect(r.status).toBe('paused');
    expect(r.pauseReason).toBe('interrupted');
    expect(activeMs(r)).toBe(7 * MIN);
  });

  it('an instant relaunch continues seamlessly', () => {
    const t = run(mk(), T0 + 7 * MIN);
    const r = recover(t, T0 + 7 * MIN + 3_000);
    expect(r.status).toBe('running');
  });

  it('paused and finished timers are unchanged by recovery', () => {
    const p = pause(run(mk(), T0 + MIN), T0 + MIN);
    expect(recover(p, T0 + 999 * MIN)).toBe(p);
  });

  it('survives JSON round-trip (what persistence does)', () => {
    const t = run(mk(), T0 + 3 * MIN);
    const back = JSON.parse(JSON.stringify(t));
    expect(activeMs(recover(back, T0 + 3 * MIN + 1000))).toBe(3 * MIN + 1000);
  });
});

describe('finalize', () => {
  it('stopping early records "stopped" with exact active time', () => {
    const t = run(mk(), T0 + 4 * MIN);
    const rec = finalize(t, T0 + 4 * MIN);
    expect(rec.outcome).toBe('stopped');
    expect(rec.activeMs).toBe(4 * MIN);
    expect(rec.segments).toHaveLength(1);
  });

  it('records an interrupted session as such', () => {
    let t = run(mk(), T0 + 4 * MIN);
    t = tick(t, T0 + 100 * MIN);
    const rec = finalize(t, T0 + 100 * MIN);
    expect(rec.outcome).toBe('interrupted');
    expect(rec.activeMs).toBe(4 * MIN);
  });
});

describe('minutesByDay (midnight boundaries)', () => {
  it('splits a session that crosses midnight', () => {
    const rules = { timeZone: 'UTC', resetHour: 0 };
    const start = Date.UTC(2026, 0, 5, 23, 40);
    const end = Date.UTC(2026, 0, 6, 0, 20);
    const out = minutesByDay([{ kind: 'focus', segments: [{ start, end }] }], rules);
    expect(out['2026-01-05']).toBeCloseTo(20);
    expect(out['2026-01-06']).toBeCloseTo(20);
  });

  it('uses the study-day reset hour and ignores breaks', () => {
    const rules = { timeZone: 'UTC', resetHour: 4 };
    const seg = { start: Date.UTC(2026, 0, 6, 1, 0), end: Date.UTC(2026, 0, 6, 2, 0) };
    expect(minutesByDay([{ kind: 'focus', segments: [seg] }], rules)).toEqual({ '2026-01-05': 60 });
    expect(minutesByDay([{ kind: 'break', segments: [seg] }], rules)).toEqual({});
  });

  it('is correct on a 25-hour DST day', () => {
    const rules = { timeZone: 'America/New_York', resetHour: 0 };
    const out = minutesByDay([{ kind: 'focus', segments: [{ start: Date.UTC(2026, 10, 1, 3, 0), end: Date.UTC(2026, 10, 1, 8, 0) }] }], rules);
    // 23:00 EDT Oct 31 -> 03:00 EST Nov 1 spans two days
    expect(out['2026-10-31']).toBeCloseTo(60);
    expect(out['2026-11-01']).toBeCloseTo(240);
  });
});
