import { type Question, gradeShort, normalize, openMistakes, scoreAttempt, understanding, validateQuestion } from './quiz';

const mc: Question = { type: 'mc', id: 'q1', prompt: '2+2?', choices: ['3', '4', '5'], answerIndex: 1 };
const short: Question = { type: 'short', id: 'q2', prompt: 'Capital of France?', answers: ['Paris'] };

describe('short answers', () => {
  it('normalises case, spacing and edge punctuation', () => {
    expect(normalize('  PaRis!! ')).toBe('paris');
    expect(gradeShort('  paris. ', ['Paris'])).toBe('correct');
  });
  it('accepts numerically equal answers incl. decimal comma', () => {
    expect(gradeShort('0,5', ['0.5'])).toBe('correct');
    expect(gradeShort('2', ['3'])).toBe('incorrect');
  });
  it('flags a single typo as close but never auto-accepts', () => {
    expect(gradeShort('Pariss', ['Paris'])).toBe('close');
    expect(gradeShort('Rome', ['Paris'])).toBe('incorrect');
    expect(gradeShort('cat', ['car'])).toBe('incorrect'); // too short for fuzzy matching
    expect(gradeShort('', ['x'])).toBe('incorrect');
  });
  it('keeps diacritics significant', () => {
    expect(gradeShort('é', ['e'])).toBe('incorrect');
  });
});

describe('scoring', () => {
  it('scores mixed quizzes and lists mistakes', () => {
    const r = scoreAttempt([mc, short], { q1: { type: 'mc', choice: 1 }, q2: { type: 'short', text: 'Lyon' } });
    expect(r).toMatchObject({ correct: 1, total: 2, fraction: 0.5, mistakeIds: ['q2'] });
  });
  it('unanswered counts as a mistake, not a crash', () => {
    const r = scoreAttempt([mc], {});
    expect(r.mistakeIds).toEqual(['q1']);
  });
  it('close answers count only if the student judges them correct', () => {
    const base = { q2: { type: 'short' as const, text: 'Pariss' } };
    expect(scoreAttempt([short], base).verdicts.q2).toBe('close');
    expect(scoreAttempt([short], { q2: { ...base.q2, selfJudged: true } }).verdicts.q2).toBe('correct');
  });
  it('empty quiz has null fraction', () => {
    expect(scoreAttempt([], {}).fraction).toBeNull();
  });
});

describe('mistake tracking', () => {
  const attempts = [
    { quizId: 'a', at: 1, verdicts: { q1: 'incorrect', q2: 'correct' } as const },
    { quizId: 'a', at: 2, verdicts: { q1: 'incorrect', q2: 'incorrect' } as const },
    { quizId: 'a', at: 3, verdicts: { q1: 'correct', q2: 'incorrect' } as const },
  ];
  it('a mistake closes when the latest attempt is correct', () => {
    const m = openMistakes(attempts.map((a) => ({ ...a, verdicts: { ...a.verdicts } })));
    expect(m.map((x) => x.questionId)).toEqual(['q2']);
    expect(m[0]!.timesWrong).toBe(2);
  });
  it('understanding is derived from latest results only', () => {
    const u = understanding(attempts.map((a) => ({ ...a, verdicts: { ...a.verdicts } })));
    expect(u).toEqual({ attempted: 2, currentlyCorrect: 1, fraction: 0.5 });
    expect(understanding([]).fraction).toBeNull();
  });
});

describe('authoring validation', () => {
  it('explains what is wrong', () => {
    expect(validateQuestion({ ...mc, prompt: ' ' })).toMatch(/question/);
    expect(validateQuestion({ ...mc, choices: ['a'] })).toMatch(/two/);
    expect(validateQuestion({ ...mc, choices: ['a', 'A'] })).toMatch(/identical/);
    expect(validateQuestion({ ...mc, answerIndex: 9 })).toMatch(/correct/);
    expect(validateQuestion({ ...short, answers: [' '] })).toMatch(/accepted/);
    expect(validateQuestion(mc)).toBeNull();
  });
});
