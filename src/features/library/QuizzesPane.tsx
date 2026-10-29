import { useMemo, useState } from 'react';
import { Pencil, Play, Plus, Trash2, X } from 'lucide-react';
import { useData } from '../../data/store';
import { useUI } from '../../app/ui-state';
import { newId } from '../../data/ids';
import { attempt, Banner, Button, Dialog, Empty, Field, IconButton, Input, TextArea, toast } from '../../design/ui';
import type { Quiz, Subject, Topic } from '../../domain/schemas';
import { type Question, openMistakes, validateQuestion } from '../../domain/quiz';

const blankMc = (): Question => ({ type: 'mc', id: newId('q'), prompt: '', choices: ['', ''], answerIndex: 0 });
const blankShort = (): Question => ({ type: 'short', id: newId('q'), prompt: '', answers: [''] });

function QuizEditor({ quiz, subject, topic, onClose }: { quiz: Quiz | 'new' | null; subject: Subject; topic: Topic | null; onClose: () => void }) {
  return quiz === null ? null : <QuizForm key={quiz === 'new' ? 'new' : quiz.id} quiz={quiz} subject={subject} topic={topic} onClose={onClose} />;
}

function QuizForm({ quiz, subject, topic, onClose }: { quiz: Quiz | 'new'; subject: Subject; topic: Topic | null; onClose: () => void }) {
  const [title, setTitle] = useState(quiz === 'new' ? '' : quiz.title);
  const [qs, setQs] = useState<Question[]>(quiz === 'new' ? [blankMc()] : (quiz.questions as Question[]));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [titleErr, setTitleErr] = useState<string | null>(null);

  const upd = (id: string, fn: (q: Question) => Question) => setQs((all) => all.map((q) => (q.id === id ? fn(q) : q)));

  const save = async () => {
    const errs: Record<string, string> = {};
    qs.forEach((q) => { const e = validateQuestion(q); if (e) errs[q.id] = e; });
    setErrors(errs);
    if (!title.trim()) { setTitleErr('Give the quiz a title.'); return; }
    if (qs.length === 0) { toast.warn('Add at least one question.'); return; }
    if (Object.keys(errs).length) { toast.warn('Some questions need attention.'); return; }
    const now = Date.now();
    const cleaned = qs.map((q) => (q.type === 'mc' ? { ...q, prompt: q.prompt.trim(), choices: q.choices.map((c) => c.trim()) } : { ...q, prompt: q.prompt.trim(), answers: q.answers.map((a) => a.trim()).filter(Boolean) }));
    const doc: Quiz = {
      id: quiz === 'new' || quiz === null ? newId('quiz') : quiz.id,
      subjectId: subject.id,
      topicId: quiz !== 'new' && quiz ? quiz.topicId : topic?.id,
      title: title.trim(),
      questions: cleaned,
      createdAt: quiz !== 'new' && quiz ? quiz.createdAt : now,
      updatedAt: now,
    };
    const r = await attempt(() => useData.getState().put('quizzes', doc), 'Could not save the quiz');
    if (r.ok) onClose();
  };

  return (
    <Dialog open onClose={onClose} wide title={quiz === 'new' ? 'New quiz' : 'Edit quiz'} description="Questions come from your own material, so you know the answers are right." footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Save quiz</Button></>}>
      <div className="stack">
        <Field label="Title" error={titleErr}><Input value={title} maxLength={120} onChange={(e) => { setTitle(e.target.value); setTitleErr(null); }} autoFocus /></Field>
        {qs.map((q, i) => (
          <div className="q-edit" key={q.id}>
            <div className="cluster" style={{ justifyContent: 'space-between' }}>
              <span className="label">Question {i + 1} · {q.type === 'mc' ? 'Multiple choice' : 'Short answer'}</span>
              <IconButton label={`Remove question ${i + 1}`} onClick={() => setQs((all) => all.filter((x) => x.id !== q.id))}><Trash2 size={15} aria-hidden /></IconButton>
            </div>
            <Field label="Question" error={errors[q.id]}>
              <TextArea value={q.prompt} onChange={(e) => upd(q.id, (x) => ({ ...x, prompt: e.target.value }))} rows={2} style={{ minHeight: 64 }} />
            </Field>
            {q.type === 'mc' ? (
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="field-label" style={{ fontSize: 'var(--fs-small)', color: 'var(--text-2)', marginBottom: 6 }}>Choices — select the correct one</legend>
                <div className="stack" style={{ gap: 'var(--s-2)' }}>
                  {q.choices.map((c, ci) => (
                    <div className="choice-row" key={ci}>
                      <input type="radio" name={`correct-${q.id}`} checked={q.answerIndex === ci} onChange={() => upd(q.id, (x) => (x.type === 'mc' ? { ...x, answerIndex: ci } : x))} aria-label={`Choice ${ci + 1} is correct`} />
                      <Input aria-label={`Choice ${ci + 1}`} value={c} onChange={(e) => upd(q.id, (x) => (x.type === 'mc' ? { ...x, choices: x.choices.map((v, j) => (j === ci ? e.target.value : v)) } : x))} />
                      {q.choices.length > 2 && <IconButton label={`Remove choice ${ci + 1}`} onClick={() => upd(q.id, (x) => (x.type === 'mc' ? { ...x, choices: x.choices.filter((_, j) => j !== ci), answerIndex: Math.min(x.answerIndex, x.choices.length - 2) } : x))}><X size={14} aria-hidden /></IconButton>}
                    </div>
                  ))}
                  {q.choices.length < 6 && <Button size="sm" variant="quiet" onClick={() => upd(q.id, (x) => (x.type === 'mc' ? { ...x, choices: [...x.choices, ''] } : x))}><Plus size={14} aria-hidden /> Add choice</Button>}
                </div>
              </fieldset>
            ) : (
              <Field label="Accepted answers" hint="One per line. Capitalisation and punctuation are ignored; numbers match by value.">
                <TextArea value={q.answers.join('\n')} onChange={(e) => upd(q.id, (x) => (x.type === 'short' ? { ...x, answers: e.target.value.split('\n') } : x))} rows={2} style={{ minHeight: 64 }} />
              </Field>
            )}
            <Field label="Explanation (shown after answering)"><TextArea value={q.explanation ?? ''} onChange={(e) => upd(q.id, (x) => ({ ...x, explanation: e.target.value || undefined }))} rows={2} style={{ minHeight: 64 }} /></Field>
          </div>
        ))}
        <div className="cluster">
          <Button onClick={() => setQs((a) => [...a, blankMc()])}><Plus size={15} aria-hidden /> Multiple choice</Button>
          <Button onClick={() => setQs((a) => [...a, blankShort()])}><Plus size={15} aria-hidden /> Short answer</Button>
        </div>
      </div>
    </Dialog>
  );
}

export function QuizzesPane({ subject, topic }: { subject: Subject; topic: Topic | null }) {
  const docs = useData((s) => s.docs);
  const [editing, setEditing] = useState<Quiz | 'new' | null>(null);
  const quizzes = useMemo(() => docs.quizzes.filter((q) => q.subjectId === subject.id && (!topic || q.topicId === topic.id)).sort((a, b) => b.updatedAt - a.updatedAt), [docs.quizzes, subject.id, topic]);
  const mistakes = useMemo(() => openMistakes(docs.attempts.map((a) => ({ quizId: a.quizId, at: a.at, verdicts: a.verdicts }))).filter((m) => quizzes.some((q) => q.id === m.quizId)), [docs.attempts, quizzes]);

  return (
    <div>
      <div className="cluster" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-3)' }}>
        <span className="label">{quizzes.length} quiz{quizzes.length === 1 ? '' : 'zes'}{mistakes.length ? ` · ${mistakes.length} open mistake${mistakes.length === 1 ? '' : 's'}` : ''}</span>
        <Button size="sm" variant="primary" onClick={() => setEditing('new')}><Plus size={14} aria-hidden /> New quiz</Button>
      </div>
      {mistakes.length > 0 && (
        <Banner tone="info" title={`${mistakes.length} question${mistakes.length === 1 ? '' : 's'} you got wrong last time.`} actions={<Button size="sm" onClick={() => { const q = mistakes[0]!; useUI.setState({ reviewMode: { kind: 'quiz', quizId: q.quizId, onlyMistakes: true } }); useUI.getState().go('review'); }}>Retry them</Button>}>
          Practising only what you missed is the quickest way to close the gaps.
        </Banner>
      )}
      {quizzes.length === 0 ? (
        <Empty title="No quizzes yet.">Write a few questions from your notes. Mistakes are tracked and can be turned into flashcards.</Empty>
      ) : (
        <ul className="rows">
          {quizzes.map((q) => {
            const attempts = docs.attempts.filter((a) => a.quizId === q.id).sort((a, b) => b.at - a.at);
            const last = attempts[0];
            return (
              <li className="row" key={q.id}>
                <div className="row-main">
                  <span className="row-title">{q.title}</span>
                  <span className="row-sub">{q.questions.length} question{q.questions.length === 1 ? '' : 's'} · {last ? `last score ${last.correct}/${last.total} · ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}` : 'not attempted yet'}</span>
                </div>
                <div className="row-end">
                  <Button size="sm" variant="primary" disabled={q.questions.length === 0} onClick={() => { useUI.setState({ reviewMode: { kind: 'quiz', quizId: q.id } }); useUI.getState().go('review'); }}><Play size={13} aria-hidden /> Take quiz</Button>
                  <IconButton label={`Edit ${q.title}`} onClick={() => setEditing(q)}><Pencil size={15} aria-hidden /></IconButton>
                  <IconButton label={`Delete ${q.title}`} onClick={() => void attempt(() => useData.getState().batch([{ del: { c: 'quizzes', id: q.id } }, ...docs.attempts.filter((a) => a.quizId === q.id).map((a) => ({ del: { c: 'attempts' as const, id: a.id } }))])).then((r) => r.ok && toast.ok('Quiz deleted.'))}><Trash2 size={15} aria-hidden /></IconButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <QuizEditor quiz={editing} subject={subject} topic={topic} onClose={() => setEditing(null)} />
    </div>
  );
}

