import { useMemo, useState } from 'react';
import { CalendarCheck, Pencil, Trash2 } from 'lucide-react';
import { useData } from '../../data/store';
import { newId } from '../../data/ids';
import { useTodayKey } from '../../state/selectors';
import { attempt, Button, Dialog, Empty, Field, IconButton, Input, Pill, Select, toast } from '../../design/ui';
import type { Exam, Task } from '../../domain/schemas';
import { examCountdown, examPlan, type ExamPlanItem } from '../../domain/planner';
import { isDayKey } from '../../domain/time';

function ExamDialog(props: { open: boolean; exam: Exam | null; onClose: () => void }) {
  return props.open ? <ExamForm key={props.exam?.id ?? 'new'} exam={props.exam} onClose={props.onClose} /> : null;
}

function ExamForm({ exam, onClose }: { exam: Exam | null; onClose: () => void }) {
  const docs = useData((s) => s.docs);
  const [f, setF] = useState(() => exam ? { title: exam.title, subjectId: exam.subjectId ?? '', date: exam.date, topicIds: exam.topicIds } : { title: '', subjectId: '', date: '', topicIds: [] as string[] });
  const [err, setErr] = useState<{ title?: string; date?: string }>({});
  const topics = docs.topics.filter((t) => t.subjectId === f.subjectId && !t.archived);
  const save = async () => {
    const e: typeof err = {};
    if (!f.title.trim()) e.title = 'Name the exam.';
    if (!isDayKey(f.date)) e.date = 'Pick the exam date.';
    setErr(e);
    if (Object.keys(e).length) return;
    const r = await attempt(() => useData.getState().put('exams', { id: exam?.id ?? newId('exam'), title: f.title.trim(), subjectId: f.subjectId || undefined, date: f.date, topicIds: f.topicIds, createdAt: exam?.createdAt ?? Date.now() }), 'Could not save the exam');
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title={exam ? 'Edit exam' : 'New exam'} footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{exam ? 'Save' : 'Add exam'}</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Exam" error={err.title}><Input value={f.title} autoFocus maxLength={120} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Physics midterm" /></Field>
        <Field label="Date" error={err.date}><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Subject"><Select value={f.subjectId} onChange={(e) => setF({ ...f, subjectId: e.target.value, topicIds: [] })}><option value="">None</option>{docs.subjects.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        {topics.length > 0 && (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label" style={{ fontSize: 'var(--fs-small)', color: 'var(--text-2)', marginBottom: 6 }}>Topics covered (none selected = all)</legend>
            <div className="cluster">
              {topics.map((t) => (
                <label key={t.id} className="switch"><input type="checkbox" checked={f.topicIds.includes(t.id)} onChange={(e) => setF({ ...f, topicIds: e.target.checked ? [...f.topicIds, t.id] : f.topicIds.filter((x) => x !== t.id) })} /><span className="track" aria-hidden /><span>{t.name}</span></label>
              ))}
            </div>
          </fieldset>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function PlanDialog({ exam, onClose }: { exam: Exam | null; onClose: () => void }) {
  return exam ? <PlanForm key={exam.id} exam={exam} onClose={onClose} /> : null;
}

function PlanForm({ exam, onClose }: { exam: Exam; onClose: () => void }) {
  const docs = useData((s) => s.docs);
  const capacity = useData((s) => s.settings.capacityMin);
  const today = useTodayKey();
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const items = useMemo<ExamPlanItem[]>(() => {
    const topics = docs.topics.filter((t) => t.subjectId === exam.subjectId && !t.archived).map((t) => ({ id: t.id, name: t.name }));
    return examPlan(exam, topics, today, capacity, docs.tasks.filter((t) => t.status === 'todo'));
  }, [exam, docs.topics, docs.tasks, today, capacity]);

  const add = async () => {
    const chosen = items.filter((_, i) => picked[i] !== false);
    const tasks: Task[] = chosen.map((it) => ({ id: newId('task'), title: it.title, subjectId: exam.subjectId, kind: 'exam-prep', due: exam.date, plannedDay: it.day, estimateMin: it.estimateMin, actualMin: 0, priority: 2, status: 'todo', examId: exam.id, createdAt: Date.now() }));
    const r = await attempt(() => useData.getState().putMany('tasks', tasks), 'Could not add the plan');
    if (r.ok) { toast.ok(`Added ${tasks.length} revision task${tasks.length === 1 ? '' : 's'} to your plan.`); onClose(); }
  };
  return (
    <Dialog open onClose={onClose} wide title={`Revision plan · ${exam.title}`} description="A first pass early, then quick reviews close to the exam. Untick anything you don’t want." footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={items.length === 0} onClick={() => void add()}>Add to my plan</Button></>}>
      {items.length === 0 ? <p className="muted">There are no days left before this exam to plan.</p> : (
        <ul className="rows">
          {items.map((it, i) => (
            <li className="row" key={i}>
              <label className="switch"><input type="checkbox" checked={picked[i] !== false} onChange={(e) => setPicked({ ...picked, [i]: e.target.checked })} aria-label={`${it.title} on ${it.day}`} /><span className="track" aria-hidden /></label>
              <span className="row-main"><span className="row-title">{it.title}</span><span className="row-sub">{it.day}</span></span>
              <span className="label">{it.estimateMin} min</span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export function ExamsTab({ createOpen, setCreateOpen }: { createOpen: boolean; setCreateOpen: (v: boolean) => void }) {
  const docs = useData((s) => s.docs);
  const today = useTodayKey();
  const [editing, setEditing] = useState<Exam | null>(null);
  const [planFor, setPlanFor] = useState<Exam | null>(null);
  const exams = [...docs.exams].sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = exams.filter((e) => e.date >= today);
  const past = exams.filter((e) => e.date < today);

  const row = (e: Exam) => {
    const c = examCountdown(e, today);
    const subj = docs.subjects.find((s) => s.id === e.subjectId);
    const prep = docs.tasks.filter((t) => t.examId === e.id);
    return (
      <li className="row" key={e.id}>
        <div className="row-main">
          <span className="row-title">{e.title}</span>
          <span className="row-sub">{subj?.name ?? 'No subject'} · {e.date}{prep.length ? ` · ${prep.filter((t) => t.status === 'done').length}/${prep.length} revision tasks done` : ''}</span>
        </div>
        <div className="row-end">
          <Pill tone={c.days <= 3 && c.days >= 0 ? 'danger' : c.days <= 7 && c.days >= 0 ? 'warn' : undefined}>{c.label}</Pill>
          {c.days > 0 && <Button size="sm" onClick={() => setPlanFor(e)}><CalendarCheck size={13} aria-hidden /> Plan revision</Button>}
          <IconButton label={`Edit ${e.title}`} onClick={() => setEditing(e)}><Pencil size={15} aria-hidden /></IconButton>
          <IconButton label={`Delete ${e.title}`} onClick={() => void attempt(() => useData.getState().remove('exams', e.id)).then((r) => r.ok && toast.ok('Exam deleted. Its revision tasks were kept.'))}><Trash2 size={15} aria-hidden /></IconButton>
        </div>
      </li>
    );
  };

  return (
    <div>
      {exams.length === 0 ? <Empty title="No exams yet." action={<Button variant="primary" onClick={() => setCreateOpen(true)}>Add an exam</Button>}>Add the date and Plan will spread revision over the days before it, around everything else you have to do.</Empty> : (
        <>
          <ul className="rows">{upcoming.map(row)}</ul>
          {past.length > 0 && <details className="sec"><summary className="label" style={{ cursor: 'pointer', padding: 'var(--s-3) 0' }}>Past · {past.length}</summary><ul className="rows">{past.map(row)}</ul></details>}
        </>
      )}
      <ExamDialog open={createOpen || !!editing} exam={editing} onClose={() => { setEditing(null); setCreateOpen(false); }} />
      <PlanDialog exam={planFor} onClose={() => setPlanFor(null)} />
    </div>
  );
}
