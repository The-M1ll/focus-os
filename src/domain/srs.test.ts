import { MAX_INTERVAL, MIN_EASE, buildQueue, newCardState, previewIntervals, retentionSummary, review, type SrsState } from './srs';

const D = '2026-03-01';
const reviewState = (over: Partial<SrsState> = {}): SrsState => ({ state: 'review', ease: 2.5, interval: 10, reps: 3, lapses: 0, due: D, ...over });

describe('new cards', () => {
  it('again keeps the card due today in learning', () => {
    const s = review(newCardState(D), 'again', D);
    expect(s).toMatchObject({ state: 'learning', due: D, interval: 0, reps: 0 });
  });
  it('good then good graduates with 1 then 3 days', () => {
    const a = review(newCardState(D), 'good', D);
    expect(a).toMatchObject({ state: 'learning', interval: 1, due: '2026-03-02', reps: 1 });
    const b = review(a, 'good', '2026-03-02');
    expect(b).toMatchObject({ state: 'review', interval: 3, due: '2026-03-05' });
  });
  it('easy graduates immediately to 4 days', () => {
    expect(review(newCardState(D), 'easy', D)).toMatchObject({ state: 'review', interval: 4, due: '2026-03-05' });
  });
  it('hard schedules tomorrow without graduating', () => {
    expect(review(newCardState(D), 'hard', D)).toMatchObject({ state: 'learning', interval: 1, due: '2026-03-02' });
  });
});

describe('review cards', () => {
  it('good multiplies by ease, always growing by at least a day', () => {
    expect(review(reviewState(), 'good', D).interval).toBe(25);
    expect(review(reviewState({ interval: 1, ease: 1.3 }), 'good', D).interval).toBe(2);
  });
  it('hard grows slowly and lowers ease', () => {
    const s = review(reviewState(), 'hard', D);
    expect(s.interval).toBe(12);
    expect(s.ease).toBe(2.35);
  });
  it('easy grows fastest and raises ease', () => {
    const s = review(reviewState(), 'easy', D);
    expect(s.interval).toBe(33); // round(10*2.5*1.3)=33
    expect(s.ease).toBe(2.65);
  });
  it('again is a lapse: interval 1, ease -0.2, relearning, counted once', () => {
    const s = review(reviewState(), 'again', D);
    expect(s).toMatchObject({ state: 'relearning', interval: 1, ease: 2.3, lapses: 1, reps: 0, due: '2026-03-02' });
  });
  it('relearning returns to review after successes', () => {
    let s = review(reviewState(), 'again', D);
    s = review(s, 'good', '2026-03-02');
    s = review(s, 'good', '2026-03-03');
    expect(s.state).toBe('review');
  });
  it('ease never drops below the floor and intervals are capped', () => {
    let s = reviewState({ ease: 1.35 });
    for (let i = 0; i < 5; i++) s = review(s, 'hard', D);
    expect(s.ease).toBe(MIN_EASE);
    const big = review(reviewState({ interval: 300, ease: 3 }), 'easy', D);
    expect(big.interval).toBe(MAX_INTERVAL);
  });
});

describe('missed reviews are not punished', () => {
  it('being overdue does not change ease or lapses; correct late recall earns bounded credit', () => {
    const onTime = review(reviewState({ due: D }), 'good', D);
    const late = review(reviewState({ due: '2026-02-19' }), 'good', D); // 10 days late
    expect(late.ease).toBe(onTime.ease);
    expect(late.lapses).toBe(0);
    expect(late.interval).toBeGreaterThan(onTime.interval);
    // credit is capped at one extra interval
    const veryLate = review(reviewState({ due: '2025-01-01' }), 'good', D);
    expect(veryLate.interval).toBe(50); // (10 + 10) * 2.5
  });
  it('reviewing early (before due) never shrinks the interval', () => {
    const early = review(reviewState({ due: '2026-03-05' }), 'good', D);
    expect(early.interval).toBeGreaterThanOrEqual(11);
  });
});

describe('determinism & preview', () => {
  it('is a pure function', () => {
    const s = reviewState();
    expect(review(s, 'good', D)).toEqual(review(s, 'good', D));
    expect(s).toEqual(reviewState());
  });
  it('previews match actual scheduling', () => {
    const s = reviewState();
    const p = previewIntervals(s, D);
    expect(p.good).toBe(25);
    expect(p.again).toBe(1);
  });
});

describe('queue', () => {
  const mk = (id: string, due: string, state: SrsState['state'] = 'review'): { id: string; srs: SrsState } => ({ id, srs: { ...reviewState({ due }), state } });
  it('orders most overdue first, caps reviews and new cards, reports backlog', () => {
    const cards = [mk('a', '2026-02-20'), mk('b', '2026-02-27'), mk('c', D), mk('d', '2026-03-09'), mk('n1', D, 'new'), mk('n2', D, 'new'), mk('n3', D, 'new')];
    const q = buildQueue(cards, D, { newPerDay: 2, maxReviews: 2 });
    expect(q.ids).toEqual(['a', 'b', 'n1', 'n2']);
    expect(q.dueReviews).toBe(3);
    expect(q.backlog).toBe(1);
    expect(q.newAvailable).toBe(3);
  });
  it('subtracts new cards already seen today and skips suspended cards', () => {
    const cards = [mk('n1', D, 'new'), { ...mk('n2', D, 'new'), suspended: true }, mk('n3', D, 'new')];
    expect(buildQueue(cards, D, { newPerDay: 2, maxReviews: 10 }, 1).ids).toEqual(['n1']);
    expect(buildQueue(cards, D, { newPerDay: 2, maxReviews: 10 }, 2).ids).toEqual([]);
  });
});

describe('retention summary', () => {
  it('derives only from stored history', () => {
    const r = retentionSummary([
      { srs: newCardState(D) },
      { srs: reviewState({ interval: 30 }) },
      { srs: reviewState({ interval: 5, lapses: 1, reps: 2 }) },
    ]);
    expect(r).toMatchObject({ total: 3, fresh: 1, mature: 1, learning: 1 });
    // attempts = reps + lapses = (0) + (3) + (2 + 1) = 6, lapses = 1
    expect(r.lapseRate).toBeCloseTo(1 / 6);
    expect(retentionSummary([]).lapseRate).toBeNull();
  });
});
