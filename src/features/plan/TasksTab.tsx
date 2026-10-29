import { useMemo, useState } from 'react';
import { Check, Pencil, Play, Trash2, CalendarPlus } from 'lucide-react';
import { useData } from '../../data/store';
import { useUI } from '../../app/ui-state';
import { useDayRules, useTodayKey } from '../../state/selectors';
import { attempt, Banner, Button, Dialog, Empty, IconButton, Pill, SectionHead, toast } from '../../design/ui';
import type { Task } from '../../domain/schemas';
import { diffDays, formatMinutes } from '../../domain/time';
import { isOverrun, proposeCatchUp, remainingMin, suggestDay } from '../../domain/planner';
import { TaskDialog } from './TaskDialog';

export function dueText(due: string | undefined, today: string): { text: string; tone?: 'warn' | 'danger' | 'info' } | null {
  if (!due) return null;
  const d = diffDays(today, due);
  if (d < 0) return { text: d === -1 ? 'Overdue · yesterday' : `Overdue · ${-d} days`, tone: 'danger' };
  if (d === 0) return { text: 'Due today', tone: 'warn' };
  if (d === 1) return { text: 'Due tomorrow', tone: 'warn' };
  return { text: `Due in ${d} days` };
}

const dayName = (k: string) => new Date(`${k}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export function TasksTab({ createOpen, setCreateOpen }: { createOpen: boolean; setCreateOpen: (v: boolean) => void }) {
  const docs = useData((s) => s.docs);
  const capacity = useData((s) => s.settings.capacityMin);
  const today = useTodayKey();
  const rules = useDayRules();
  const [editing, setEditing] = useState<Task | null>(null);
  const [catchUp, setCatchUp] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  void rules;

  const subjects = useMemo(() => new Map(docs.subjects.map((s) => [s.id, s])), [docs.subjects]);
  const open = docs.tasks.filter((t) => t.status === 'todo');
  const done = docs.tasks.filter((t) => t.status === 'done').sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)).slice(0, 15);

  const groups = useMemo(() => {
    const g: Record<string, Task[]> = { overdue: [], today: [], soon: [], later: [], none: [] };
    for (const t of open) {
      if (!t.due) g.none!.push(t);
      else if (t.due < today) g.overdue!.push(t);
      else if (t.due === today) g.today!.push(t);
      else if (diffDays(today, t.due) <= 7) g.soon!.push(t);
      else g.later!.push(t);
    }
    for (const k of Object.keys(g)) g[k]!.sort((a, b) => (a.due ?? '').localeCompare(b.due ?? '') || b.priority - a.priority || a.title.localeCompare(b.title));
    return g;
  }, [open, today]);

  const missed = useMemo(() => proposeCatchUp(docs.tasks, today, capacity), [docs.tasks, today, capacity]);

  const setDone = (t: Task, v: boolean) =>
    void attempt(() => useData.getState().put('tasks', { ...t, status: v ? 'done' : 'todo', completedAt: v ? Date.now() : undefined })).then((r) => r.ok && v && toast.ok(`Marked “${t.title}” done.`, { label: 'Undo', run: () => setDone({ ...t, status: 'done' }, false) }));

  const mutate = (t: Task, patch: Partial<Task>, msg?: string) => void attempt(() => useData.getState().put('tasks', { ...t, ...patch })).then((r) => r.ok && msg && toast.ok(msg));

  const applyCatchUp = async () => {
    const chosen = missed.filter((m) => picked[m.taskId] !== false);
    const ops = chosen.map((m) => ({ put: { c: 'tasks' as const, doc: { ...docs.tasks.find((t) => t.id === m.taskId)!, plannedDay: m.to } } }));
    if (ops.length === 0) return setCatchUp(false);
    const r = await attempt(() => useData.getState().batch(ops), 'Could not move the tasks');
    if (r.ok) { toast.ok(`Moved ${ops.length} task${ops.length === 1 ? '' : 's'}.`); setCatchUp(false); }
  };

  const renderRow = (t: Task) => {
    const sub = t.subjectId ? subjects.get(t.subjectId) : undefined;
    const due = dueText(t.due, today);
    const over = isOverrun(t);
    const adviceDay = over ? suggestDay(t, docs.tasks, today, capacity) : null;
    return (
      <li key={t.id}>
        <div className={`row ${t.status === 'done' ? 'task-done' : ''}`}>
          <button className="task-check" role="checkbox" aria-checked={t.status === 'done'} aria-label={`Mark “${t.title}” as done`} onClick={() => setDone(t, t.status !== 'done')}>{t.status === 'done' && <Check size={14} aria-hidden />}</button>
          <div className="row-main">
            <span className="row-title">{t.title}</span>
            <span className="row-sub">
              {sub && <>{sub.name} · </>}{formatMinutes(t.estimateMin)} est.{t.actualMin > 0 && ` · ${formatMinutes(t.actualMin)} spent`}{t.plannedDay && ` · planned ${dayName(t.plannedDay)}`}
            </span>
          </div>
          <div className="row-end">
            {t.priority === 3 && <Pill tone="warn">High</Pill>}
            {due && t.status === 'todo' && <Pill tone={due.tone}>{due.text}</Pill>}
            {t.status === 'todo' && <Button size="sm" aria-label={`Focus on ${t.title}`} onClick={() => { useUI.setState({ focusTaskId: t.id }); useUI.getState().go('today'); }}><Play size={13} aria-hidden /> Focus</Button>}
            <IconButton label={`Edit ${t.title}`} onClick={() => setEditing(t)}><Pencil size={15} aria-hidden /></IconButton>
            <IconButton label={`Delete ${t.title}`} onClick={() => void attempt(() => useData.getState().remove('tasks', t.id)).then((r) => r.ok && toast.ok('Task deleted.', { label: 'Undo', run: () => void useData.getState().put('tasks', t) }))}><Trash2 size={15} aria-hidden /></IconButton>
          </div>
        </div>
        {over && adviceDay && (
          <div className="overrun" role="status">
            <span>Taking longer than the {formatMinutes(t.estimateMin)} you estimated — that’s normal. About {formatMinutes(remainingMin(t))} more?</span>
            <Button size="sm" onClick={() => mutate(t, { estimateMin: Math.min(960, t.actualMin + 20) }, 'Added 20 more minutes.')}>Add 20 min</Button>
            <Button size="sm" variant="quiet" onClick={() => mutate(t, { plannedDay: adviceDay.day }, `Planned for ${dayName(adviceDay.day)}.`)}><CalendarPlus size={13} aria-hidden /> Plan for {adviceDay.day === today ? 'later today' : dayName(adviceDay.day)}</Button>
          </div>
        )}
      </li>
    );
  };

  // Number only the sections that are actually shown.
  const shown = ['overdue', 'today', 'soon', 'later', 'none'].filter((k) => groups[k]!.length > 0);
  const section = (key: string, title: string) =>
    groups[key]!.length > 0 && (
      <div className="sec" key={key}>
        <SectionHead index={String(shown.indexOf(key) + 1).padStart(2, '0')} title={`${title} · ${groups[key]!.length}`} />
        <ul className="rows">{groups[key]!.map(renderRow)}</ul>
      </div>
    );

  return (
    <div>
      {missed.length > 0 && (
        <Banner title={`${missed.length} planned task${missed.length === 1 ? ' was' : 's were'} missed.`} actions={<Button size="sm" onClick={() => { setPicked({}); setCatchUp(true); }}>Review new days</Button>}>
          That happens. Pick new days that fit your week — nothing moves until you confirm.
        </Banner>
      )}
      {open.length === 0 ? (
        <Empty title="Nothing on your list." action={<Button variant="primary" onClick={() => setCreateOpen(true)}>Add a task</Button>}>Add homework and study tasks with a rough time estimate. Plan will tell you what to do first and warn you when a day gets too full.</Empty>
      ) : (
        <>
          {section('overdue', 'Overdue')}
          {section('today', 'Due today')}
          {section('soon', 'This week')}
          {section('later', 'Later')}
          {section('none', 'No due date')}
        </>
      )}
      {done.length > 0 && (
        <details className="sec">
          <summary className="label" style={{ cursor: 'pointer', padding: 'var(--s-3) 0' }}>Recently done · {done.length}</summary>
          <ul className="rows">{done.map(renderRow)}</ul>
        </details>
      )}

      <TaskDialog open={createOpen || !!editing} task={editing} onClose={() => { setEditing(null); setCreateOpen(false); }} />
      <Dialog open={catchUp} onClose={() => setCatchUp(false)} wide title="Move missed tasks" description="Suggested days use your daily capacity. Untick anything you want to leave." footer={<><Button variant="quiet" onClick={() => setCatchUp(false)}>Cancel</Button><Button variant="primary" onClick={() => void applyCatchUp()}>Move selected</Button></>}>
        <ul className="rows">
          {missed.map((m) => {
            const t = docs.tasks.find((x) => x.id === m.taskId)!;
            return (
              <li className="row" key={m.taskId}>
                <label className="switch"><input type="checkbox" checked={picked[m.taskId] !== false} onChange={(e) => setPicked({ ...picked, [m.taskId]: e.target.checked })} aria-label={`Move ${t.title}`} /><span className="track" aria-hidden /></label>
                <span className="row-main"><span className="row-title">{t.title}</span><span className="row-sub">{m.from ? dayName(m.from) : '—'} → <b style={{ color: 'var(--text)' }}>{dayName(m.to)}</b> · {m.reason}{t.due ? ` · due ${dayName(t.due)}` : ''}</span></span>
                {m.tight && <Pill tone="warn">Tight</Pill>}
              </li>
            );
          })}
        </ul>
      </Dialog>
    </div>
  );
}

