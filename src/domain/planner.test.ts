import { estimateAccuracy, examPlan, examCountdown, isOverrun, proposeCatchUp, remainingMin, suggestDay, suggestNext, weeklyReview, workload } from './planner';
import type { Exam, Task } from './schemas';

const TODAY = '2026-03-02'; // Monday
let n = 0;
const task = (o: Partial<Task> = {}): Task => ({ id: `t${++n}`, title: 'x', kind: 'homework', estimateMin: 30, actualMin: 0, priority: 2, status: 'todo', createdAt: 0, ...o });
const exam = (o: Partial<Exam> = {}): Exam => ({ id: `e${++n}`, title: 'Maths', date: '2026-03-10', topicIds: [], createdAt: 0, ...o });

describe('remaining time', () => {
  it('uses the estimate minus actual, with a buffer once the student overruns', () => {
    expect(remainingMin(task({ estimateMin: 60, actualMin: 20 }))).toBe(40);
    expect(remainingMin(task({ estimateMin: 30, actualMin: 45 }))).toBe(15);
    expect(remainingMin(task({ status: 'done' }))).toBe(0);
    expect(isOverrun(task({ estimateMin: 30, actualMin: 45 }))).toBe(true);
    expect(isOverrun(task({ estimateMin: 30, actualMin: 0 }))).toBe(false);
  });
});

describe('what to do next', () => {
  it('puts overdue before due today before due later, with human reasons', () => {
    const overdue = task({ title: 'overdue', due: '2026-03-01' });
    const today = task({ title: 'today', due: TODAY });
    const later = task({ title: 'later', due: '2026-03-20' });
    const s = suggestNext([later, today, overdue], [], TODAY);
    expect(s.map((x) => x.task.title)).toEqual(['overdue', 'today', 'later']);
    expect(s[0]!.reasons[0]).toMatch(/due yesterday/i);
    expect(s[1]!.reasons).toContain('Due today');
  });
  it('considers nearby exams in the same subject and ignores finished tasks', () => {
    const a = task({ title: 'maths hw', subjectId: 'math', due: '2026-03-06' });
    const b = task({ title: 'art', subjectId: 'art', due: '2026-03-06' });
    const done = task({ status: 'done', due: '2026-03-02' });
    const s = suggestNext([b, a, done], [exam({ subjectId: 'math', date: '2026-03-05' })], TODAY);
    expect(s[0]!.task.title).toBe('maths hw');
    expect(s[0]!.reasons.join()).toMatch(/Exam in 3 days/);
    expect(s.find((x) => x.task.id === done.id)).toBeUndefined();
  });
  it('gives an honest reason when nothing is urgent', () => {
    const s = suggestNext([task()], [], TODAY);
    expect(s[0]!.reasons[0]).toMatch(/Nothing urgent/);
  });
  it('is stable for ties (deterministic)', () => {
    const ts = [task({ id: 'b' }), task({ id: 'a' })];
    expect(suggestNext(ts, [], TODAY).map((s) => s.task.id)).toEqual(['a', 'b']);
  });
});

describe('workload and day suggestions', () => {
  it('sums remaining time of planned tasks and flags overload', () => {
    const tasks = [task({ plannedDay: TODAY, estimateMin: 100 }), task({ plannedDay: TODAY, estimateMin: 80 })];
    const [l] = workload(tasks, [TODAY], 150);
    expect(l).toMatchObject({ plannedMin: 180, over: true });
  });
  it('finds the earliest day with room before the deadline', () => {
    const busy = task({ plannedDay: TODAY, estimateMin: 140 });
    const t = task({ due: '2026-03-05', estimateMin: 30 });
    expect(suggestDay(t, [busy, t], TODAY, 150)).toEqual({ day: '2026-03-03', tight: false, afterDeadline: false });
  });
  it('reports a tight plan instead of silently overloading', () => {
    const full = ['2026-03-02', '2026-03-03'].map((d) => task({ plannedDay: d, estimateMin: 150 }));
    const t = task({ due: '2026-03-03', estimateMin: 30 });
    const c = suggestDay(t, [...full, t], TODAY, 150);
    expect(c.tight).toBe(true);
    expect(c.afterDeadline).toBe(false);
  });
  it('deadline already passed -> earliest room, flagged as after the deadline', () => {
    const t = task({ due: '2026-02-20' });
    expect(suggestDay(t, [t], TODAY, 150)).toEqual({ day: TODAY, tight: false, afterDeadline: true });
    const full = task({ plannedDay: TODAY, estimateMin: 150 });
    expect(suggestDay(t, [t, full], TODAY, 150)).toEqual({ day: '2026-03-03', tight: false, afterDeadline: true });
  });
});

describe('catch-up after missed plans', () => {
  it('proposes new days without mutating tasks and accounts for earlier proposals', () => {
    const a = task({ plannedDay: '2026-03-01', estimateMin: 120, due: '2026-03-04' });
    const b = task({ plannedDay: '2026-02-28', estimateMin: 120, due: '2026-03-04' });
    const before = JSON.stringify([a, b]);
    const p = proposeCatchUp([a, b], TODAY, 150);
    expect(JSON.stringify([a, b])).toBe(before);
    expect(p).toHaveLength(2);
    expect(new Set(p.map((x) => x.to)).size).toBe(2); // 120+120 > 150, so they cannot share a day
  });
});

describe('estimate accuracy', () => {
  it('needs enough real samples and uses the median', () => {
    const mk = (est: number, act: number) => task({ status: 'done', estimateMin: est, actualMin: act });
    expect(estimateAccuracy([mk(30, 45), mk(30, 30)])).toBeNull();
    const r = estimateAccuracy([mk(30, 30), mk(30, 45), mk(30, 60), mk(30, 36), mk(60, 600)]);
    expect(r).toEqual({ ratio: 1.5, samples: 5 });
  });
});

describe('exam plan', () => {
  const topics = [{ id: 'p1', name: 'Algebra' }, { id: 'p2', name: 'Geometry' }, { id: 'p3', name: 'Probability' }];
  it('schedules every topic before the exam, within capacity, never on exam day', () => {
    const e = exam({ date: '2026-03-09' });
    const plan = examPlan(e, topics, TODAY, 150, []);
    expect(plan.filter((p) => p.title.startsWith('Study')).map((p) => p.topicId).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(plan.every((p) => p.day >= TODAY && p.day < e.date)).toBe(true);
    const perDay = new Map<string, number>();
    plan.forEach((p) => perDay.set(p.day, (perDay.get(p.day) ?? 0) + p.estimateMin));
    expect([...perDay.values()].every((m) => m <= 150)).toBe(true);
    expect(plan.some((p) => p.title.startsWith('Quick review'))).toBe(true);
  });
  it('returns nothing when the exam is today or past, and compresses when it is tomorrow', () => {
    expect(examPlan(exam({ date: TODAY }), topics, TODAY, 150, [])).toEqual([]);
    const plan = examPlan(exam({ date: '2026-03-03' }), topics, TODAY, 150, []);
    expect(plan.every((p) => p.day === TODAY)).toBe(true);
  });
  it('respects existing load', () => {
    const heavy = task({ plannedDay: TODAY, estimateMin: 150 });
    const plan = examPlan(exam({ date: '2026-03-06' }), topics.slice(0, 1), TODAY, 150, [heavy]);
    expect(plan.find((p) => p.title.startsWith('Study'))!.day).not.toBe(TODAY);
  });
});

describe('weekly review and countdown', () => {
  it('summarises the week without scoring', () => {
    const doneThisWeek = task({ status: 'done', completedAt: Date.UTC(2026, 2, 3, 12), actualMin: 20 });
    const doneLastWeek = task({ status: 'done', completedAt: Date.UTC(2026, 1, 20, 12) });
    const open = task({ due: '2026-03-04' });
    const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const r = weeklyReview([doneThisWeek, doneLastWeek, open], { '2026-03-02': 25.4, '2026-03-04': 50 }, [exam({ date: '2026-03-12' })], TODAY, utcDay);
    expect(r.weekStart).toBe('2026-03-02');
    expect(r.completed.map((t) => t.id)).toEqual([doneThisWeek.id]);
    expect(r.carryOver.map((t) => t.id)).toEqual([open.id]);
    expect(r.focusMinutesTotal).toBe(75);
    expect(r.upcomingExams).toHaveLength(1);
  });
  it('assigns completion to the student\'s day, not UTC', () => {
    // 2026-03-01 23:30 in UTC-5 is 2026-03-02 04:30 UTC; the student's day is still Sunday the 1st (previous week).
    const late = task({ status: 'done', completedAt: Date.UTC(2026, 2, 2, 4, 30) });
    const local = (ms: number) => new Date(ms - 5 * 3_600_000).toISOString().slice(0, 10);
    expect(weeklyReview([late], {}, [], TODAY, local).completed).toHaveLength(0);
    expect(weeklyReview([late], {}, [], TODAY, (ms) => new Date(ms).toISOString().slice(0, 10)).completed).toHaveLength(1);
  });
  it('labels countdowns', () => {
    expect(examCountdown(exam({ date: TODAY }), TODAY).label).toBe('today');
    expect(examCountdown(exam({ date: '2026-03-03' }), TODAY).label).toBe('tomorrow');
    expect(examCountdown(exam({ date: '2026-03-12' }), TODAY).label).toBe('in 10 days');
    expect(examCountdown(exam({ date: '2026-03-01' }), TODAY).label).toBe('passed');
  });
});
