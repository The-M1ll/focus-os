/**
 * Planner logic. Everything here *proposes*; nothing mutates tasks on its own and nothing
 * produces a score or grade for the student's behaviour.
 */

import { addDays, diffDays, rangeDays, weekStart } from './time';
import type { Exam, Task } from './schemas';

export const OVERRUN_BUFFER_MIN = 15;

const open = (t: Task) => t.status === 'todo';

/** Minutes of work we still expect. If the student is already past their estimate, assume a modest buffer. */
export function remainingMin(t: Task): number {
  if (!open(t)) return 0;
  const left = t.estimateMin - t.actualMin;
  return left > 0 ? left : OVERRUN_BUFFER_MIN;
}

export const isOverrun = (t: Task) => open(t) && t.actualMin >= t.estimateMin && t.actualMin > 0;

export interface Suggestion {
  task: Task;
  reasons: string[];
  rank: number;
}

export function suggestNext(tasks: Task[], exams: Exam[], today: string, limit = 3): Suggestion[] {
  const examsBySubject = new Map<string, Exam[]>();
  for (const e of exams) if (e.subjectId && diffDays(today, e.date) >= 0) examsBySubject.set(e.subjectId, [...(examsBySubject.get(e.subjectId) ?? []), e]);

  const out: Suggestion[] = [];
  for (const task of tasks.filter(open)) {
    const reasons: string[] = [];
    let rank = 0;
    if (task.due) {
      const d = diffDays(today, task.due);
      if (d < 0) {
        rank += 100 + Math.min(-d, 10);
        reasons.push(d === -1 ? 'Was due yesterday' : `Was due ${-d} days ago`);
      } else if (d === 0) {
        rank += 80;
        reasons.push('Due today');
      } else if (d === 1) {
        rank += 60;
        reasons.push('Due tomorrow');
      } else if (d <= 3) {
        rank += 40 - d;
        reasons.push(`Due in ${d} days`);
      } else if (d <= 7) {
        rank += 15;
      }
    }
    if (task.plannedDay && task.plannedDay <= today) {
      rank += 25;
      reasons.push(task.plannedDay === today ? 'Planned for today' : 'Planned earlier and not done yet');
    }
    if (task.priority === 3) {
      rank += 20;
      reasons.push('Marked high priority');
    } else if (task.priority === 1) rank -= 5;
    const ex = task.subjectId ? examsBySubject.get(task.subjectId) : undefined;
    if (ex?.length) {
      const nearest = Math.min(...ex.map((e) => diffDays(today, e.date)));
      if (nearest <= 14) {
        rank += 20 - Math.floor(nearest);
        reasons.push(nearest === 0 ? 'Exam today in this subject' : `Exam in ${nearest} day${nearest === 1 ? '' : 's'} in this subject`);
      }
    }
    if (isOverrun(task)) reasons.push('Taking longer than estimated');
    if (remainingMin(task) <= 15 && rank > 0) {
      rank += 5;
      reasons.push('Quick to finish');
    }
    if (reasons.length === 0) reasons.push('Nothing urgent – a good time to get ahead');
    out.push({ task, reasons, rank });
  }
  return out.sort((a, b) => b.rank - a.rank || (a.task.due ?? '9999').localeCompare(b.task.due ?? '9999') || a.task.id.localeCompare(b.task.id)).slice(0, limit);
}

export interface DayLoad {
  day: string;
  plannedMin: number;
  dueCount: number;
  capacityMin: number;
  over: boolean;
}

export function workload(tasks: Task[], days: string[], capacityMin: number): DayLoad[] {
  return days.map((day) => {
    const planned = tasks.filter((t) => open(t) && t.plannedDay === day);
    const plannedMin = planned.reduce((a, t) => a + remainingMin(t), 0);
    return { day, plannedMin, dueCount: tasks.filter((t) => open(t) && t.due === day).length, capacityMin, over: plannedMin > capacityMin };
  });
}

export interface DayChoice {
  day: string;
  /** true when no day before the deadline has room; the student should decide knowingly. */
  tight: boolean;
  afterDeadline: boolean;
}

/** Earliest day (from today) that still fits the task before its deadline. */
export function suggestDay(task: Task, tasks: Task[], today: string, capacityMin: number, horizon = 21): DayChoice {
  const need = remainingMin(task);
  const others = tasks.filter((t) => t.id !== task.id);
  const lastDay = task.due && task.due >= today ? task.due : addDays(today, horizon);
  const days = rangeDays(today, Math.max(1, diffDays(today, lastDay) + 1));
  const loads = workload(others, days, capacityMin);
  const pastDue = !!task.due && task.due < today;
  const fit = loads.find((l) => l.plannedMin + need <= l.capacityMin);
  if (fit) return { day: fit.day, tight: false, afterDeadline: pastDue };
  const least = [...loads].sort((a, b) => a.plannedMin - b.plannedMin || a.day.localeCompare(b.day))[0]!;
  return { day: pastDue ? today : least.day, tight: true, afterDeadline: pastDue };
}

export interface RescheduleProposal {
  taskId: string;
  from: string | undefined;
  to: string;
  reason: string;
  tight: boolean;
}

/** Proposes new days for planned-but-missed work. The caller shows these for confirmation. */
export function proposeCatchUp(tasks: Task[], today: string, capacityMin: number): RescheduleProposal[] {
  const missed = tasks.filter((t) => open(t) && t.plannedDay && t.plannedDay < today).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || b.priority - a.priority);
  const working = tasks.map((t) => ({ ...t }));
  const out: RescheduleProposal[] = [];
  for (const t of missed) {
    const choice = suggestDay(t, working, today, capacityMin);
    out.push({
      taskId: t.id,
      from: t.plannedDay,
      to: choice.day,
      tight: choice.tight,
      reason: choice.afterDeadline ? 'Past its deadline – earliest day with room' : choice.tight ? 'No day before the deadline has room – least busy day' : 'Earliest day with room before the deadline',
    });
    const w = working.find((x) => x.id === t.id);
    if (w) w.plannedDay = choice.day; // later proposals see the earlier ones
  }
  return out;
}

/** Median of actual/estimate over finished tasks – null until there is enough real data. */
export function estimateAccuracy(tasks: Task[], minSamples = 4): { ratio: number; samples: number } | null {
  const ratios = tasks.filter((t) => t.status === 'done' && t.actualMin > 0 && t.estimateMin > 0).map((t) => t.actualMin / t.estimateMin).sort((a, b) => a - b);
  if (ratios.length < minSamples) return null;
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  return { ratio: Math.round(median * 100) / 100, samples: ratios.length };
}

export interface ExamPlanItem {
  day: string;
  title: string;
  estimateMin: number;
  topicId?: string;
}

/**
 * Spreads revision of each topic over the days before an exam: a first pass early, a second
 * quick pass in the final days. Draft only – the student picks which items to add.
 */
export function examPlan(exam: Exam, topics: { id: string; name: string }[], today: string, capacityMin: number, existing: Task[]): ExamPlanItem[] {
  const left = diffDays(today, exam.date);
  if (left < 1) return [];
  const useTopics = (exam.topicIds.length ? topics.filter((t) => exam.topicIds.includes(t.id)) : topics).slice(0, 40);
  const items = useTopics.length ? useTopics : [{ id: '', name: exam.title }];
  const days = rangeDays(today, left); // today .. day before exam
  const load = new Map(workload(existing, days, capacityMin).map((l) => [l.day, l.plannedMin]));
  const place = (preferred: number, min: number): string => {
    for (let off = 0; off < days.length; off++) {
      for (const idx of [preferred + off, preferred - off]) {
        const d = days[idx];
        if (d !== undefined && (load.get(d) ?? 0) + min <= capacityMin) {
          load.set(d, (load.get(d) ?? 0) + min);
          return d;
        }
      }
    }
    const lightest = [...days].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0))[0]!;
    load.set(lightest, (load.get(lightest) ?? 0) + min);
    return lightest;
  };
  const out: ExamPlanItem[] = [];
  const firstWindow = Math.max(1, Math.ceil(days.length * 0.65));
  items.forEach((tp, i) => {
    const idx = Math.min(firstWindow - 1, Math.floor((i / items.length) * firstWindow));
    out.push({ day: place(idx, 40), title: `Study: ${tp.name}`, estimateMin: 40, topicId: tp.id || undefined });
  });
  if (days.length >= 3) {
    items.forEach((tp, i) => {
      const startSecond = Math.max(firstWindow, days.length - Math.min(3, days.length));
      const idx = Math.min(days.length - 1, startSecond + (i % Math.max(1, days.length - startSecond)));
      out.push({ day: place(idx, 20), title: `Quick review: ${tp.name}`, estimateMin: 20, topicId: tp.id || undefined });
    });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.title.localeCompare(b.title));
}

export interface WeeklyReview {
  weekStart: string;
  completed: Task[];
  carryOver: Task[];
  focusMinutesByDay: Record<string, number>;
  focusMinutesTotal: number;
  upcomingExams: Exam[];
  accuracy: { ratio: number; samples: number } | null;
}

/** `dayOf` maps a timestamp to the student's study-day key (time zone and reset hour aware). */
export function weeklyReview(tasks: Task[], focusByDay: Record<string, number>, exams: Exam[], today: string, dayOf: (ms: number) => string): WeeklyReview {
  const ws = weekStart(today);
  const we = addDays(ws, 6);
  const inWeek = (day?: string) => !!day && day >= ws && day <= we;
  const completed = tasks.filter((t) => t.status === 'done' && t.completedAt !== undefined && inWeek(dayOf(t.completedAt)));
  const carryOver = tasks.filter((t) => open(t) && ((t.due && t.due <= we) || (t.plannedDay && t.plannedDay <= we)));
  const byDay: Record<string, number> = {};
  for (const d of rangeDays(ws, 7)) byDay[d] = Math.round(focusByDay[d] ?? 0);
  return {
    weekStart: ws,
    completed,
    carryOver,
    focusMinutesByDay: byDay,
    focusMinutesTotal: Object.values(byDay).reduce((a, b) => a + b, 0),
    upcomingExams: exams.filter((e) => e.date >= today && diffDays(today, e.date) <= 21).sort((a, b) => a.date.localeCompare(b.date)),
    accuracy: estimateAccuracy(tasks),
  };
}

export function examCountdown(e: Exam, today: string): { days: number; label: string } {
  const days = diffDays(today, e.date);
  return { days, label: days < 0 ? 'passed' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days` };
}
