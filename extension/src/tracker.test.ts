import { chunkForUpload, decide, mergePending, observe, platformForUrl, MAX_CREDIT_SEC, type Rule, type TrackerState } from './tracker';

const rule = (o: Partial<Rule> = {}): Rule => ({ platform: 'youtube', domains: ['youtube.com', 'youtu.be'], daily_limit_minutes: 30, blocked: false, self_reported_minutes: 0, allowed_windows: [], origin: 'personal', ...o });
const DR = { timeZone: 'UTC', resetHour: 0 };
const T0 = Date.UTC(2026, 2, 2, 12, 0, 0);

describe('platformForUrl', () => {
  const rules = [rule(), rule({ platform: 'reddit', domains: ['reddit.com'] })];
  it('matches the domain and its subdomains only', () => {
    expect(platformForUrl('https://www.youtube.com/watch?v=1', rules)?.platform).toBe('youtube');
    expect(platformForUrl('https://youtu.be/abc', rules)?.platform).toBe('youtube');
    expect(platformForUrl('https://old.reddit.com/r/x', rules)?.platform).toBe('reddit');
    expect(platformForUrl('https://notyoutube.com/', rules)).toBeNull();
    expect(platformForUrl('https://youtube.com.evil.example/', rules)).toBeNull();
  });
  it('ignores non-web URLs and garbage', () => {
    expect(platformForUrl('chrome://extensions', rules)).toBeNull();
    expect(platformForUrl('file:///etc/passwd', rules)).toBeNull();
    expect(platformForUrl('not a url', rules)).toBeNull();
  });
});

describe('observe: crediting foreground time', () => {
  const step = (s: TrackerState, at: number, engaged: boolean, platform: string | null = 'youtube') => observe(s, { at, engaged, platform }, DR);

  it('credits the interval only if the previous observation was engaged', () => {
    let st: TrackerState = { last: null };
    let r = step(st, T0, true);
    expect(r.credit).toBeNull();
    r = step(r.state, T0 + 30_000, true);
    expect(r.credit).toEqual({ platform: 'youtube', seconds: 30, day: '2026-03-02' });
    r = step(r.state, T0 + 60_000, false, null); // user went idle at this tick
    expect(r.credit?.seconds).toBe(30);
    r = step(r.state, T0 + 90_000, false, null);
    expect(r.credit).toBeNull(); // nothing while not engaged
    st = r.state;
    expect(st.last?.engaged).toBe(false);
  });

  it('never credits more than the cap, so a suspended worker cannot invent time', () => {
    let r = step({ last: null }, T0, true);
    r = step(r.state, T0 + 3 * 3600_000, true); // worker slept for 3 hours
    expect(r.credit?.seconds).toBe(MAX_CREDIT_SEC);
  });

  it('a backwards clock jump credits nothing', () => {
    let r = step({ last: null }, T0, true);
    r = step(r.state, T0 - 60_000, true);
    expect(r.credit).toBeNull();
  });

  it('credits the interval to the day it started in (midnight, reset hour)', () => {
    const rules = { timeZone: 'UTC', resetHour: 4 };
    const before = Date.UTC(2026, 2, 3, 3, 59, 40);
    let r = observe({ last: null }, { at: before, engaged: true, platform: 'youtube' }, rules);
    r = observe(r.state, { at: before + 30_000, engaged: true, platform: 'youtube' }, rules);
    expect(r.credit?.day).toBe('2026-03-02'); // still the previous study day
  });

  it('does not credit across a platform change', () => {
    let r = step({ last: null }, T0, true, 'reddit');
    r = step(r.state, T0 + 20_000, true, 'youtube');
    expect(r.credit).toEqual({ platform: 'reddit', seconds: 20, day: '2026-03-02' });
  });
});

describe('decide', () => {
  it('blocks when over budget, counting self-reported minutes', () => {
    expect(decide(rule(), 20 * 60, T0, 'UTC')).toEqual({ allow: true });
    expect(decide(rule(), 30 * 60, T0, 'UTC')).toEqual({ allow: false, reason: 'budget' });
    expect(decide(rule({ self_reported_minutes: 15 }), 15 * 60, T0, 'UTC')).toEqual({ allow: false, reason: 'budget' });
  });
  it('blocks outside allowed hours and when class-blocked', () => {
    const r = rule({ daily_limit_minutes: null, allowed_windows: [{ days: [], start_min: 18 * 60, end_min: 20 * 60 }] });
    expect(decide(r, 0, T0, 'UTC')).toEqual({ allow: false, reason: 'outside_hours' });
    expect(decide(r, 0, Date.UTC(2026, 2, 2, 19, 0), 'UTC')).toEqual({ allow: true });
    expect(decide(rule({ blocked: true }), 0, T0, 'UTC')).toEqual({ allow: false, reason: 'blocked' });
  });
  it('no budget and no windows means allowed', () => {
    expect(decide(rule({ daily_limit_minutes: null }), 99999, T0, 'UTC')).toEqual({ allow: true });
  });
  it('a zero budget blocks immediately', () => {
    expect(decide(rule({ daily_limit_minutes: 0 }), 0, T0, 'UTC')).toEqual({ allow: false, reason: 'budget' });
  });
});

describe('upload batching', () => {
  it('merges per day+platform and splits into bridge-sized chunks', () => {
    let p = mergePending([], { platform: 'youtube', seconds: 100, day: 'd' });
    p = mergePending(p, { platform: 'youtube', seconds: 50, day: 'd' });
    p = mergePending(p, { platform: 'reddit', seconds: 5, day: 'd' });
    expect(p).toEqual([{ platform: 'youtube', seconds: 150, day: 'd' }, { platform: 'reddit', seconds: 5, day: 'd' }]);
    expect(chunkForUpload([{ platform: 'x', seconds: 7300, day: 'd' }]).map((c) => c.seconds)).toEqual([3600, 3600, 100]);
    expect(mergePending(p, null)).toBe(p);
  });
});
