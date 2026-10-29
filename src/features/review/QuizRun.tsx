import { useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useData } from '../../data/store';
import { newId } from '../../data/ids';
import { useTodayKey } from '../../state/selectors';
import { attempt, Banner, Button, Field, Input, Meter, toast } from '../../design/ui';
import { type Answer, type Question, type Verdict, gradeQuestion, openMistakes, scoreAttempt } from '../../domain/quiz';
import { newCardState } from '../../domain/srs';
import type { Card } from '../../domain/schemas';

const correctText = (q: Question) => (q.type === 'mc' ? q.choices[q.answerIndex] ?? '' : q.answers[0] ?? '');

export function QuizRun({ quizId, onlyMistakes, onExit, onRetryMistakes }: { quizId: string; onlyMistakes?: boolean; onExit: () => void; onRetryMistakes: () => void }) {
  const quiz = useData((s) => s.docs.quizzes.find((q) => q.id === quizId));
  const attemptsAll = useData((s) => s.docs.attempts);
  const cards = useData((s) => s.docs.cards);
  const today = useTodayKey();

  const questions = useMemo<Question[]>(() => {
    if (!quiz) return [];
    const all = quiz.questions as Question[];
    if (!onlyMistakes) return all;
    const ids = new Set(openMistakes(attemptsAll.filter((a) => a.quizId === quizId).map((a) => ({ quizId: a.quizId, at: a.at, verdicts: a.verdicts }))).map((m) => m.questionId));
    return all.filter((q) => ids.has(q.id));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [checked, setChecked] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof scoreAttempt> | null>(null);
  const [saving, setSaving] = useState(false);

  if (!quiz) return <div className="session"><Banner tone="danger" title="That quiz no longer exists." actions={<Button size="sm" onClick={onExit}>Back</Button>} /></div>;
  if (questions.length === 0) return <div className="session"><div className="empty"><p className="display-italic">No mistakes left to practise.</p><Button variant="primary" onClick={onExit}>Back</Button></div></div>;

  const q = questions[idx]!;
  const ans = answers[q.id];
  const graded: Verdict | null = checked ? gradeQuestion(q, ans) : null;
  // After the student declines a near-miss, treat it as a plain miss in the UI.
  const verdict: Verdict | null = graded === 'close' && ans?.type === 'short' && ans.selfJudged === false ? 'incorrect' : graded;
  const canCheck = q.type === 'mc' ? ans?.type === 'mc' && ans.choice !== null : ans?.type === 'short' && ans.text.trim().length > 0;

  const finish = async (finalAnswers: Record<string, Answer>) => {
    const r = scoreAttempt(questions, finalAnswers);
    setSaving(true);
    const res = await attempt(() => useData.getState().put('attempts', { id: newId('att'), quizId, at: Date.now(), verdicts: r.verdicts, correct: r.correct, total: r.total }), 'The result was not saved');
    setSaving(false);
    if (res.ok) setResult(r);
  };

  const next = () => {
    setChecked(false);
    if (idx + 1 < questions.length) setIdx(idx + 1);
    else void finish(answers);
  };

  const addMistakeCards = async () => {
    if (!result) return;
    const existing = new Set(cards.map((c) => c.front.trim().toLowerCase()));
    const fresh: Card[] = questions
      .filter((x) => result.verdicts[x.id] !== 'correct' && !existing.has(x.prompt.trim().toLowerCase()))
      .map((x) => ({ id: newId('card'), subjectId: quiz.subjectId, topicId: quiz.topicId, front: x.prompt, back: x.explanation ? `${correctText(x)}\n\n${x.explanation}` : correctText(x), source: 'quiz-mistake', createdAt: Date.now(), srs: newCardState(today) }));
    if (fresh.length === 0) return toast.info('Those questions are already flashcards.');
    const r = await attempt(() => useData.getState().putMany('cards', fresh), 'Could not create the cards');
    if (r.ok) toast.ok(`Added ${fresh.length} flashcard${fresh.length === 1 ? '' : 's'}. They will come back on a schedule.`);
  };

  if (result) {
    const remaining = openMistakes([...attemptsAll.filter((a) => a.quizId === quizId).map((a) => ({ quizId: a.quizId, at: a.at, verdicts: a.verdicts }))]);
    return (
      <div className="session">
        <p className="label">{quiz.title}</p>
        <h1 className="display" style={{ fontSize: 'var(--fs-h1)', margin: 'var(--s-2) 0 var(--s-4)' }}>{result.correct} of {result.total} correct.</h1>
        <Meter value={result.correct} max={result.total} label="Score" />
        {result.mistakeIds.length > 0 && (
          <div className="sec" style={{ marginTop: 'var(--s-6)' }}>
            <div className="sec-head"><h2>To review</h2></div>
            <ul className="rows">
              {questions.filter((x) => result.verdicts[x.id] !== 'correct').map((x) => (
                <li key={x.id} className="row" style={{ alignItems: 'flex-start' }}>
                  <div className="row-main">
                    <span className="row-title">{x.prompt}</span>
                    <span className="row-sub">Answer: <b style={{ color: 'var(--text)' }}>{correctText(x)}</b>{x.explanation ? ` — ${x.explanation}` : ''}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="cluster" style={{ marginTop: 'var(--s-6)' }}>
          {result.mistakeIds.length > 0 && <Button variant="primary" onClick={() => void addMistakeCards()}>Turn mistakes into flashcards</Button>}
          {remaining.some((m) => m.quizId === quizId) && <Button onClick={onRetryMistakes}>Retry mistakes</Button>}
          <Button variant="quiet" onClick={onExit}>Done</Button>
        </div>
        <p className="faint" style={{ marginTop: 'var(--s-4)', fontSize: 'var(--fs-small)' }}>Your score reflects only this quiz. It is not a grade and isn’t shared with anyone.</p>
      </div>
    );
  }

  return (
    <div className="session">
      <div className="session-top">
        <Button size="sm" variant="quiet" onClick={onExit}>Leave quiz</Button>
        <span className="label">{quiz.title} · {idx + 1} / {questions.length}</span>
        <span />
      </div>
      <Meter value={idx + (checked ? 1 : 0)} max={questions.length} label="Quiz progress" />
      <form onSubmit={(e) => { e.preventDefault(); if (!checked && canCheck) setChecked(true); else if (checked && verdict !== 'close') next(); }}>
        <p className="flash-q" style={{ textAlign: 'left', margin: 'var(--s-6) 0 var(--s-4)', fontSize: 'var(--fs-h2)' }}>{q.prompt}</p>
        {q.type === 'mc' ? (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sr-only">Choose one answer</legend>
            <ul className="choices">
              {q.choices.map((c, i) => {
                const chosen = ans?.type === 'mc' && ans.choice === i;
                const v = checked ? (i === q.answerIndex ? 'right' : chosen ? 'wrong' : undefined) : undefined;
                return (
                  <li key={i}>
                    <label className="choice" data-verdict={v}>
                      <input type="radio" name={q.id} checked={chosen} disabled={checked} onChange={() => setAnswers({ ...answers, [q.id]: { type: 'mc', choice: i } })} />
                      <span className="label">{String.fromCharCode(65 + i)}</span>
                      <span style={{ flex: 1 }}>{c}</span>
                      {v === 'right' && <><Check size={18} aria-hidden /><span className="sr-only">Correct answer</span></>}
                      {v === 'wrong' && <><X size={18} aria-hidden /><span className="sr-only">Your answer, incorrect</span></>}
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ) : (
          <Field label="Your answer">
            <Input value={ans?.type === 'short' ? ans.text : ''} disabled={checked} autoFocus onChange={(e) => setAnswers({ ...answers, [q.id]: { type: 'short', text: e.target.value } })} autoComplete="off" />
          </Field>
        )}

        {checked && (
          <div style={{ marginTop: 'var(--s-4)' }} role="status">
            {verdict === 'correct' && <Banner tone="ok" title="Correct.">{q.explanation}</Banner>}
            {verdict === 'incorrect' && <Banner tone="danger" title="Not quite.">The answer is <b>{correctText(q)}</b>. {q.explanation}</Banner>}
            {verdict === 'close' && (
              <Banner title="Very close.">
                You wrote “{ans?.type === 'short' ? ans.text : ''}”; the accepted answer is <b>{correctText(q)}</b>. {q.explanation} Do you count it as correct?
                <div className="cluster" style={{ marginTop: 8 }}>
                  <Button size="sm" onClick={() => { setAnswers({ ...answers, [q.id]: { type: 'short', text: ans?.type === 'short' ? ans.text : '', selfJudged: true } }); }}>Yes, count it</Button>
                  <Button size="sm" variant="quiet" onClick={() => { setAnswers({ ...answers, [q.id]: { type: 'short', text: ans?.type === 'short' ? ans.text : '', selfJudged: false } }); }}>No</Button>
                </div>
              </Banner>
            )}
          </div>
        )}
        <div className="cluster" style={{ marginTop: 'var(--s-5)' }}>
          {!checked ? (
            <Button type="submit" variant="primary" disabled={!canCheck}>Check answer</Button>
          ) : (
            <Button type="submit" variant="primary" busy={saving} disabled={verdict === 'close'}>{idx + 1 < questions.length ? 'Next question' : 'Finish'}</Button>
          )}
        </div>
      </form>
    </div>
  );
}
