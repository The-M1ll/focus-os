import { useMemo } from 'react';
import { BookOpenCheck, Play } from 'lucide-react';
import { useData } from '../../data/store';
import { useUI } from '../../app/ui-state';
import { useTodayKey } from '../../state/selectors';
import { Button, Empty, SectionHead } from '../../design/ui';
import { buildQueue } from '../../domain/srs';
import { openMistakes } from '../../domain/quiz';
import { addDays } from '../../domain/time';
import { CardSession } from './CardSession';
import { QuizRun } from './QuizRun';
import './review.css';

export function Review() {
  const mode = useUI((s) => s.reviewMode);
  const docs = useData((s) => s.docs);
  const settings = useData((s) => s.settings);
  const today = useTodayKey();
  const exit = () => useUI.setState({ reviewMode: null });

  const queue = useMemo(() => buildQueue(docs.cards, today, { newPerDay: settings.newCardsPerDay, maxReviews: settings.maxReviewsPerDay }, docs.reviews.filter((r) => r.day === today && r.wasNew).length), [docs.cards, docs.reviews, today, settings]);
  const bySubject = useMemo(
    () => docs.subjects.filter((s) => !s.archived).map((s) => {
      const q = buildQueue(docs.cards.filter((c) => c.subjectId === s.id), today, { newPerDay: settings.newCardsPerDay, maxReviews: settings.maxReviewsPerDay }, docs.reviews.filter((r) => r.day === today && r.wasNew).length);
      return { s, n: q.ids.length };
    }).filter((x) => x.n > 0),
    [docs, today, settings],
  );
  const mistakes = useMemo(() => openMistakes(docs.attempts.map((a) => ({ quizId: a.quizId, at: a.at, verdicts: a.verdicts }))), [docs.attempts]);
  const last7 = useMemo(() => { const from = addDays(today, -6); return docs.reviews.filter((r) => r.day >= from); }, [docs.reviews, today]);
  const recallRate = last7.length ? Math.round((last7.filter((r) => r.grade !== 'again').length / last7.length) * 100) : null;

  if (mode?.kind === 'cards') return <CardSession key="cards" scope={mode.scope} onExit={exit} />;
  if (mode?.kind === 'quiz') return <QuizRun key={`${mode.quizId}-${mode.onlyMistakes}`} quizId={mode.quizId} onlyMistakes={mode.onlyMistakes} onExit={exit} onRetryMistakes={() => useUI.setState({ reviewMode: { kind: 'quiz', quizId: mode.quizId, onlyMistakes: true } })} />;

  return (
    <div>
      <header className="page-head">
        <div>
          <p className="label">Retrieval practice</p>
          <h1 className="display">Review</h1>
          <p>Trying to remember is what makes it stick. Short sessions, often, beat long ones.</p>
        </div>
      </header>

      <div className="grid-2">
        <div>
          <div className="sec">
            <SectionHead index="01" title="Flashcards" />
            {docs.cards.length === 0 ? (
              <Empty title="No flashcards yet." action={<Button onClick={() => useUI.getState().go('library')}>Open the Library</Button>}>Make cards from your notes and they will appear here when it is time.</Empty>
            ) : (
              <>
                <div className="stats">
                  <div className="stat"><b>{queue.ids.length}</b><span className="label">Ready now</span></div>
                  <div className="stat"><b>{queue.dueReviews}</b><span className="label">Due</span></div>
                  <div className="stat"><b>{queue.newAvailable}</b><span className="label">New</span></div>
                  {recallRate !== null && <div className="stat"><b>{recallRate}%</b><span className="label">Remembered, 7 days</span></div>}
                </div>
                <div className="cluster">
                  <Button variant="primary" size="lg" disabled={queue.ids.length === 0} onClick={() => useUI.setState({ reviewMode: { kind: 'cards' } })}><BookOpenCheck size={18} aria-hidden /> Start review</Button>
                  {queue.backlog > 0 && <span className="muted">{queue.backlog} more waiting — they will keep.</span>}
                </div>
                {recallRate !== null && <p className="faint" style={{ marginTop: 'var(--s-3)', fontSize: 'var(--fs-small)' }}>Based on {last7.length} answers in the last 7 days. Not a grade — just what you answered.</p>}
                {bySubject.length > 1 && (
                  <ul className="rows" style={{ marginTop: 'var(--s-4)' }}>
                    {bySubject.map(({ s, n }) => (
                      <li className="row" key={s.id}>
                        <span className="row-main"><span className="row-title">{s.name}</span><span className="row-sub">{n} ready</span></span>
                        <Button size="sm" onClick={() => useUI.setState({ reviewMode: { kind: 'cards', scope: { subjectId: s.id } } })}>Review</Button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
        <div>
          <div className="sec">
            <SectionHead index="02" title="Quizzes" />
            {docs.quizzes.length === 0 ? (
              <Empty title="No quizzes yet.">Write questions in the Library’s Quizzes tab.</Empty>
            ) : (
              <ul className="rows">
                {docs.quizzes.map((q) => {
                  const last = docs.attempts.filter((a) => a.quizId === q.id).sort((a, b) => b.at - a.at)[0];
                  const miss = mistakes.filter((m) => m.quizId === q.id).length;
                  return (
                    <li className="row" key={q.id}>
                      <span className="row-main"><span className="row-title">{q.title}</span><span className="row-sub">{q.questions.length} questions{last ? ` · last ${last.correct}/${last.total}` : ''}{miss ? ` · ${miss} to revisit` : ''}</span></span>
                      <div className="row-end">
                        {miss > 0 && <Button size="sm" onClick={() => useUI.setState({ reviewMode: { kind: 'quiz', quizId: q.id, onlyMistakes: true } })}>Mistakes</Button>}
                        <Button size="sm" variant="primary" disabled={q.questions.length === 0} onClick={() => useUI.setState({ reviewMode: { kind: 'quiz', quizId: q.id } })}><Play size={13} aria-hidden /> Take</Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
