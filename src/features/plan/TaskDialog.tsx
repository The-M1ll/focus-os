import { useMemo, useState } from 'react';
import { useData } from '../../data/store';
import { newId } from '../../data/ids';
import { useTodayKey } from '../../state/selectors';
import { attempt, Button, Dialog, Field, Input, Segmented, Select, TextArea } from '../../design/ui';
import type { Task } from '../../domain/schemas';
import { estimateAccuracy } from '../../domain/planner';
import { isDayKey } from '../../domain/time';

export function TaskDialog(props: { open: boolean; task: Task | null; onClose: () => void; presetDay?: string }) {
  return props.open ? <TaskForm key={props.task?.id ?? 'new'} task={props.task} presetDay={props.presetDay} onClose={props.onClose} /> : null;
}

function TaskForm({ task, onClose, presetDay }: { task: Task | null; onClose: () => void; presetDay?: string }) {
  const docs = useData((s) => s.docs);
  const today = useTodayKey();
  const [f, setF] = useState(() => task
    ? { title: task.title, subjectId: task.subjectId ?? '', kind: task.kind, due: task.due ?? '', plannedDay: task.plannedDay ?? '', estimateMin: task.estimateMin, priority: task.priority, notes: task.notes ?? '' }
    : { title: '', subjectId: '', kind: 'homework' as Task['kind'], due: '', plannedDay: presetDay ?? '', estimateMin: 30, priority: 2 as 1 | 2 | 3, notes: '' });
  const [errors, setErrors] = useState<{ title?: string; due?: string; estimate?: string }>({});
  const acc = useMemo(() => estimateAccuracy(docs.tasks), [docs.tasks]);

  const save = async () => {
    const e: typeof errors = {};
    if (!f.title.trim()) e.title = 'What needs doing?';
    if (f.due && !isDayKey(f.due)) e.due = 'Pick a valid date.';
    if (!(f.estimateMin >= 5 && f.estimateMin <= 960)) e.estimate = 'Estimate between 5 and 960 minutes.';
    setErrors(e);
    if (Object.keys(e).length) return;
    const doc: Task = {
      id: task?.id ?? newId('task'),
      title: f.title.trim(),
      subjectId: f.subjectId || undefined,
      kind: f.kind,
      due: f.due || undefined,
      plannedDay: f.plannedDay || undefined,
      estimateMin: Math.round(f.estimateMin),
      actualMin: task?.actualMin ?? 0,
      priority: f.priority,
      status: task?.status ?? 'todo',
      examId: task?.examId,
      notes: f.notes.trim() || undefined,
      createdAt: task?.createdAt ?? Date.now(),
      completedAt: task?.completedAt,
    };
    const r = await attempt(() => useData.getState().put('tasks', doc), 'Could not save the task');
    if (r.ok) onClose();
  };

  return (
    <Dialog open onClose={onClose} title={task ? 'Edit task' : 'New task'} footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{task ? 'Save' : 'Add task'}</Button></>}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Task" error={errors.title} className="full"><Input value={f.title} maxLength={200} autoFocus onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Chemistry worksheet 3" /></Field>
        <Field label="Subject">
          <Select value={f.subjectId} onChange={(e) => setF({ ...f, subjectId: e.target.value })}>
            <option value="">None</option>
            {docs.subjects.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label="Type">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Task['kind'] })}>
            <option value="homework">Homework</option><option value="study">Study</option><option value="exam-prep">Exam prep</option><option value="other">Other</option>
          </Select>
        </Field>
        <Field label="Due date" error={errors.due} hint="Optional"><Input type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field>
        <Field label="Plan for" hint={`Optional. Today is ${today}.`}><Input type="date" value={f.plannedDay} onChange={(e) => setF({ ...f, plannedDay: e.target.value })} /></Field>
        <Field label="Estimate (minutes)" error={errors.estimate} hint={acc && acc.ratio >= 1.15 ? `You usually take ${acc.ratio}× your estimates (from ${acc.samples} finished tasks).` : undefined}>
          <Input type="number" min={5} max={960} step={5} value={f.estimateMin} onChange={(e) => setF({ ...f, estimateMin: Number(e.target.value) })} />
        </Field>
        <div className="field">
          <span className="field-label">Priority</span>
          <Segmented label="Priority" value={f.priority} onChange={(v) => setF({ ...f, priority: v })} options={[{ value: 1, label: 'Low' }, { value: 2, label: 'Normal' }, { value: 3, label: 'High' }]} />
        </div>
        {acc && acc.ratio >= 1.15 && (
          <div className="full"><Button size="sm" variant="quiet" onClick={() => setF({ ...f, estimateMin: Math.round((f.estimateMin * acc.ratio) / 5) * 5 })}>Adjust estimate to {Math.round((f.estimateMin * acc.ratio) / 5) * 5} min</Button></div>
        )}
        <Field label="Notes" className="full"><TextArea value={f.notes} maxLength={4000} onChange={(e) => setF({ ...f, notes: e.target.value })} rows={3} /></Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
