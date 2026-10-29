/**
 * Deterministic spaced-repetition scheduler (SM-2 family, simplified and fully specified).
 * No randomness, no hidden penalties. See DESIGN notes in docs: ARCHITECTURE.md §Learning.
 *
 *  grades:   again | hard | good | easy
 *  state:    new -> learning -> review  (a lapse moves review -> relearning -> review)
 *
 *  new / learning / relearning:
 *     again -> due today (stay in the learning queue)           interval 0
 *     hard  -> due in 1 day                                      interval 1
 *     good  -> due in 1 day (new) or 3 days (second success)      interval 1 | 3
 *     easy  -> due in 4 days                                     interval 4   (graduates)
 *  review (interval i, ease e, overdue o days):
 *     again -> lapse: ease -= 0.20 (min 1.3), interval 1, state relearning
 *     hard  -> ease -= 0.15 (min 1.3), interval = max(i+1, round(i*1.2))
 *     good  -> interval = max(i+1, round(base*e))
 *     easy  -> ease += 0.15, interval = max(i+2, round(base*e*1.3))
 *       where base = i + min(floor(o/2), i)   // late-but-correct recall earns bounded extra credit
 *  Being late is never penalised: overdue alone never causes a lapse or an ease change.
 *  Intervals are capped at MAX_INTERVAL days.
 */

import { addDays, diffDays } from './time';

export type Grade = 'again' | 'hard' | 'good' | 'easy';
export type CardState = 'new' | 'learning' | 'review' | 'relearning';

export interface SrsState {
  state: CardState;
  ease: number;
  interval: number; // days
  reps: number; // successful reviews in a row (resets on lapse)
  lapses: number;
  due: string; // 'YYYY-MM-DD' study day
  lastReviewed?: string;
}

export const MAX_INTERVAL = 365;
export const MIN_EASE = 1.3;
export const DEFAULT_EASE = 2.5;

export function newCardState(today: string): SrsState {
  return { state: 'new', ease: DEFAULT_EASE, interval: 0, reps: 0, lapses: 0, due: today };
}

const clampEase = (e: number) => Math.max(MIN_EASE, Math.round(e * 100) / 100);
const clampInterval = (i: number) => Math.min(MAX_INTERVAL, Math.max(0, Math.round(i)));

export function review(s: SrsState, grade: Grade, today: string): SrsState {
  const overdue = Math.max(0, diffDays(s.due, today));
  const base = { ...s, lastReviewed: today };

  if (s.state === 'new' || s.state === 'learning' || s.state === 'relearning') {
    switch (grade) {
      case 'again':
        return { ...base, state: s.state === 'new' ? 'learning' : s.state, interval: 0, reps: 0, due: today };
      case 'hard':
        return { ...base, state: s.state === 'new' ? 'learning' : s.state, interval: 1, due: addDays(today, 1) };
      case 'good': {
        const second = s.state !== 'new' && s.reps >= 1;
        const interval = second ? 3 : 1;
        return { ...base, state: second ? 'review' : s.state === 'new' ? 'learning' : s.state, interval, reps: s.reps + 1, due: addDays(today, interval) };
      }
      case 'easy':
        return { ...base, state: 'review', interval: 4, reps: s.reps + 1, due: addDays(today, 4) };
    }
  }

  // review state
  const i = Math.max(1, s.interval);
  switch (grade) {
    case 'again':
      return { ...base, state: 'relearning', ease: clampEase(s.ease - 0.2), interval: 1, reps: 0, lapses: s.lapses + 1, due: addDays(today, 1) };
    case 'hard': {
      const next = clampInterval(Math.max(i + 1, i * 1.2));
      return { ...base, ease: clampEase(s.ease - 0.15), interval: next, reps: s.reps + 1, due: addDays(today, next) };
    }
    case 'good': {
      const eff = i + Math.min(Math.floor(overdue / 2), i);
      const next = clampInterval(Math.max(i + 1, eff * s.ease));
      return { ...base, interval: next, reps: s.reps + 1, due: addDays(today, next) };
    }
    case 'easy': {
      const eff = i + Math.min(Math.floor(overdue / 2), i);
      const next = clampInterval(Math.max(i + 2, eff * s.ease * 1.3));
      return { ...base, ease: clampEase(s.ease + 0.15), interval: next, reps: s.reps + 1, due: addDays(today, next) };
    }
  }
}

/** Preview of what each answer would schedule, shown on the buttons. */
export function previewIntervals(s: SrsState, today: string): Record<Grade, number> {
  const out = {} as Record<Grade, number>;
  for (const g of ['again', 'hard', 'good', 'easy'] as Grade[]) out[g] = diffDays(today, review(s, g, today).due);
  return out;
}

export interface QueueOptions {
  newPerDay: number;
  maxReviews: number;
}

export interface QueueCard {
  id: string;
  srs: SrsState;
  suspended?: boolean;
}

export interface Queue {
  /** Cards to show now, most overdue first, new cards last. */
  ids: string[];
  dueReviews: number;
  newAvailable: number;
  /** Reviews left over because of the daily cap (a backlog the user is never forced to clear). */
  backlog: number;
}

/**
 * Builds today's queue. `newSeenToday` = how many new cards were already introduced today.
 * The cap prevents a returning student from facing hundreds of cards after a few missed days.
 */
export function buildQueue(cards: QueueCard[], today: string, opts: QueueOptions, newSeenToday = 0): Queue {
  const live = cards.filter((c) => !c.suspended);
  const due = live
    .filter((c) => c.srs.state !== 'new' && c.srs.due <= today)
    .sort((a, b) => (a.srs.due === b.srs.due ? a.id.localeCompare(b.id) : a.srs.due < b.srs.due ? -1 : 1));
  const fresh = live.filter((c) => c.srs.state === 'new').sort((a, b) => a.id.localeCompare(b.id));
  const newBudget = Math.max(0, opts.newPerDay - newSeenToday);
  const shownReviews = due.slice(0, opts.maxReviews);
  const shownNew = fresh.slice(0, newBudget);
  return {
    ids: [...shownReviews, ...shownNew].map((c) => c.id),
    dueReviews: due.length,
    newAvailable: fresh.length,
    backlog: Math.max(0, due.length - shownReviews.length),
  };
}

/** Topic-level understanding derived ONLY from review history (no invented numbers). */
export function retentionSummary(cards: { srs: SrsState }[]): { total: number; mature: number; learning: number; fresh: number; lapseRate: number | null } {
  let mature = 0;
  let learning = 0;
  let fresh = 0;
  let lapses = 0;
  let reps = 0;
  for (const c of cards) {
    if (c.srs.state === 'new') fresh++;
    else if (c.srs.state === 'review' && c.srs.interval >= 21) mature++;
    else learning++;
    lapses += c.srs.lapses;
    reps += c.srs.reps + c.srs.lapses;
  }
  return { total: cards.length, mature, learning, fresh, lapseRate: reps > 0 ? lapses / reps : null };
}
