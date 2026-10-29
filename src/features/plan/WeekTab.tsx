import { useMemo, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { useData } from '../../data/store';
import { useTodayKey } from '../../state/selectors';
import { attempt, Button, Meter, Pill, toast } from '../../design/ui';
import { addDays, formatMinutes, rangeDays, weekStart } from '../../domain/time';
import { remainingMin, suggestDay, workload } from '../../domain/planner';
import { TaskDialog } from './TaskDialog';

export function WeekTab() {
  const docs = useData((s) => s.docs);
  const capacity = useData((s) => s.settings.capacityMin);
  const today = useTodayKey();
  const [offset, setOffset] = useState(0);
  const [addDay, setAddDay] = useState<string | null>(null);
  const start = addDays(weekStart(today), offset * 7);
  const days = rangeDays(start, 7);
  const load = useMemo(() => workload(docs.tasks, days, capacity), [docs.tasks, days, capacity]);
  const subjects = new Map(docs.subjects.map((s) => [s.id, s]));
  const unplanned = docs.tasks.filter((t) => t.status === 'todo' && !t.plannedDay);

  const label = (k: string) => new Date(`${k}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' });

  return (
    <div>
      <div className="cluster" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-4)' }}>
        <span className="label">Week of {start}</span>
        <div className="cluster">
          <Button size="sm" variant="quiet" onClick={() => setOffset(offset - 1)}>Previous</Button>
          <Button size="sm" variant="quiet" disabled={offset === 0} onClick={() => setOffset(0)}>This week</Button>
          <Button size="sm" variant="quiet" onClick={() => setOffset(offset + 1)}>Next</Button>
        </div>
      </div>
      <div className="week" role="list" aria-label="Week plan">
        {days.map((d, i) => {
          const l = load[i]!;
          const planned = docs.tasks.filter((t) => t.status === 'todo' && t.plannedDay === d);
          const due = docs.tasks.filter((t) => t.status === 'todo' && t.due === d && t.plannedDay !== d);
          const exams = docs.exams.filter((e) => e.date === d);
          return (
            <section key={d} className="week-day" data-today={d === today} role="listitem" aria-label={label(d)}>
              <div className="cluster" style={{ justifyContent: 'space-between' }}>
                <h3>{label(d)}</h3>
                {l.over && <Pill tone="warn">Full</Pill>}
              </div>
              <Meter value={l.plannedMin} max={capacity} tone={l.over ? 'warn' : undefined} label={`${label(d)} workload ${l.plannedMin} of ${capacity} minutes`} />
              <p className="faint" style={{ fontSize: 'var(--fs-micro)', margin: '4px 0 0' }}>{formatMinutes(l.plannedMin)} of {formatMinutes(capacity)}</p>
              {exams.map((e) => <div key={e.id} className="week-item"><Pill tone="danger">Exam</Pill><span className="t">{e.title}</span></div>)}
              {planned.map((t) => (
                <div key={t.id} className="week-item">
                  <span className="t">{t.title}</span>
                  <span className="faint">{subjects.get(t.subjectId ?? '')?.name ?? ''} {formatMinutes(remainingMin(t))}</span>
                  <span className="cluster" style={{ gap: 4 }}>
                    <Button size="sm" variant="quiet" aria-label={`Mark ${t.title} done`} onClick={() => void attempt(() => useData.getState().put('tasks', { ...t, status: 'done', completedAt: Date.now() }))}><Check size={13} aria-hidden /></Button>
                    <Button size="sm" variant="quiet" onClick={() => void attempt(() => useData.getState().put('tasks', { ...t, plannedDay: undefined }))}>Unplan</Button>
                  </span>
                </div>
              ))}
              {due.map((t) => <div key={t.id} className="week-item"><span className="t">{t.title}</span><span className="faint">due · not planned</span></div>)}
              <Button size="sm" variant="quiet" style={{ marginTop: 'var(--s-2)' }} onClick={() => setAddDay(d)} aria-label={`Add task on ${label(d)}`}><Plus size={13} aria-hidden /> Add</Button>
            </section>
          );
        })}
      </div>

      {unplanned.length > 0 && (
        <div className="sec" style={{ marginTop: 'var(--s-6)' }}>
          <div className="sec-head"><h2>Not planned yet · {unplanned.length}</h2></div>
          <ul className="rows">
            {unplanned.map((t) => {
              const s = suggestDay(t, docs.tasks, today, capacity);
              return (
                <li className="row" key={t.id}>
                  <span className="row-main"><span className="row-title">{t.title}</span><span className="row-sub">{formatMinutes(remainingMin(t))}{t.due ? ` · due ${t.due}` : ''}</span></span>
                  <Button size="sm" onClick={() => void attempt(() => useData.getState().put('tasks', { ...t, plannedDay: s.day })).then((r) => r.ok && toast.ok(`Planned for ${label(s.day)}.`))}>
                    Plan for {s.day === today ? 'today' : label(s.day)}{s.tight ? ' (tight)' : ''}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <TaskDialog open={!!addDay} task={null} presetDay={addDay ?? undefined} onClose={() => setAddDay(null)} />
    </div>
  );
}
