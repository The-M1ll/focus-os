/** Quiz scoring, mistake tracking and topic-level understanding. All derived from real attempts. */

export interface McQuestion {
  type: 'mc';
  id: string;
  prompt: string;
  choices: string[];
  answerIndex: number;
  explanation?: string;
}
export interface ShortQuestion {
  type: 'short';
  id: string;
  prompt: string;
  /** Any of these (after normalisation) is accepted. */
  answers: string[];
  explanation?: string;
}
export type Question = McQuestion | ShortQuestion;

export type Verdict = 'correct' | 'incorrect' | 'close';

export function normalize(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:!?'"()\-–—]+|[\s.,;:!?'"()\-–—]+$/g, '')
    .trim();
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

const asNumber = (s: string): number | null => {
  const t = s.replace(',', '.').replace(/\s/g, '');
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

/**
 * Exact (normalised) or numerically equal -> correct. One typo on a longer answer -> "close":
 * the UI asks the student to decide; we never silently accept or reject near-misses.
 */
export function gradeShort(input: string, accepted: string[]): Verdict {
  const x = normalize(input);
  if (!x) return 'incorrect';
  const nx = asNumber(x);
  let close = false;
  for (const a of accepted) {
    const y = normalize(a);
    if (x === y) return 'correct';
    const ny = asNumber(y);
    if (nx !== null && ny !== null) {
      if (Math.abs(nx - ny) < 1e-9) return 'correct';
      continue;
    }
    if (y.length >= 5 && editDistance(x, y) <= 1) close = true;
  }
  return close ? 'close' : 'incorrect';
}

export type Answer = { type: 'mc'; choice: number | null } | { type: 'short'; text: string; selfJudged?: boolean };

export function gradeQuestion(q: Question, a: Answer | undefined): Verdict {
  if (!a) return 'incorrect';
  if (q.type === 'mc' && a.type === 'mc') return a.choice === q.answerIndex ? 'correct' : 'incorrect';
  if (q.type === 'short' && a.type === 'short') {
    const v = gradeShort(a.text, q.answers);
    if (v === 'close') return a.selfJudged === true ? 'correct' : 'close';
    return v;
  }
  return 'incorrect';
}

export interface AttemptResult {
  correct: number;
  total: number;
  /** 0..1, null for an empty quiz. */
  fraction: number | null;
  verdicts: Record<string, Verdict>;
  mistakeIds: string[];
}

export function scoreAttempt(questions: Question[], answers: Record<string, Answer>): AttemptResult {
  const verdicts: Record<string, Verdict> = {};
  let correct = 0;
  const mistakeIds: string[] = [];
  for (const q of questions) {
    const v = gradeQuestion(q, answers[q.id]);
    verdicts[q.id] = v;
    if (v === 'correct') correct++;
    else mistakeIds.push(q.id);
  }
  return { correct, total: questions.length, fraction: questions.length ? correct / questions.length : null, verdicts, mistakeIds };
}

export interface AttemptLog {
  quizId: string;
  at: number;
  verdicts: Record<string, Verdict>;
}

/** Questions whose most recent attempt was not correct (the live "mistakes" list). */
export function openMistakes(attempts: AttemptLog[]): { quizId: string; questionId: string; lastAt: number; timesWrong: number }[] {
  const latest = new Map<string, { quizId: string; questionId: string; lastAt: number; ok: boolean }>();
  const wrong = new Map<string, number>();
  for (const at of [...attempts].sort((a, b) => a.at - b.at)) {
    for (const [qid, v] of Object.entries(at.verdicts)) {
      const key = `${at.quizId}/${qid}`;
      latest.set(key, { quizId: at.quizId, questionId: qid, lastAt: at.at, ok: v === 'correct' });
      if (v !== 'correct') wrong.set(key, (wrong.get(key) ?? 0) + 1);
    }
  }
  return [...latest.entries()]
    .filter(([, v]) => !v.ok)
    .map(([k, v]) => ({ quizId: v.quizId, questionId: v.questionId, lastAt: v.lastAt, timesWrong: wrong.get(k) ?? 1 }))
    .sort((a, b) => b.lastAt - a.lastAt);
}

/** Share of attempted questions currently answered correctly (null = nothing attempted yet). */
export function understanding(attempts: AttemptLog[]): { attempted: number; currentlyCorrect: number; fraction: number | null } {
  const latest = new Map<string, boolean>();
  for (const at of [...attempts].sort((a, b) => a.at - b.at)) {
    for (const [qid, v] of Object.entries(at.verdicts)) latest.set(`${at.quizId}/${qid}`, v === 'correct');
  }
  const attempted = latest.size;
  const currentlyCorrect = [...latest.values()].filter(Boolean).length;
  return { attempted, currentlyCorrect, fraction: attempted ? currentlyCorrect / attempted : null };
}

export function validateQuestion(q: Question): string | null {
  if (!q.prompt.trim()) return 'Write the question.';
  if (q.type === 'mc') {
    const choices = q.choices.map((c) => c.trim());
    if (choices.length < 2) return 'Add at least two choices.';
    if (choices.some((c) => !c)) return 'Fill in or remove empty choices.';
    if (new Set(choices.map(normalize)).size !== choices.length) return 'Two choices are identical.';
    if (q.answerIndex < 0 || q.answerIndex >= choices.length) return 'Mark which choice is correct.';
  } else if (!q.answers.some((a) => a.trim())) {
    return 'Add at least one accepted answer.';
  }
  return null;
}
