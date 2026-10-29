import { Gyro } from '../../design/Ambient';
import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowRight, BookOpenCheck, CalendarClock, Coffee, Pause, Play, Plus, RotateCcw, Square, TimerReset, ShieldAlert } from 'lucide-react';
import { useData } from '../../data/store';
import { useTimer } from '../../state/timer';
import { useUI } from '../../app/ui-state';
import { useDayRules, useNow, useTodayKey } from '../../state/selectors';
import { Banner, Button, Field, Input, Pill, Segmented, SectionHead, Select, toast } from '../../design/ui';
import { Dial } from './Dial';
import { activeMs, remainingMs } from '../../domain/timer';
import { formatDuration, formatMinutes, dayStartMs } from '../../domain/time';
import { suggestNext, examCountdown, remainingMin } from '../../domain/planner';
import { buildQueue } from '../../domain/srs';
import { minutesByDay } from '../../domain/timer';
import { completedInRow, nextBreak } from '../../domain/wellness';
import { combineRules, evaluate, aggregateUsage, extensionLink, allPlatforms } from '../../domain/limits';
import { useLimitInputs } from '../limits/useLimitInputs';
import './today.css';

const greeting = (h: number) => (h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening');

export function Today() {
  const settings = useData((s) => s.settings);
  const docs = useData((s) => s.docs);
  const timer = useTimer((s) => s.timer);
  const notice = useTimer((s) => s.recoveredNotice);
  const persistError = useTimer((s) => s.persistError);
  const { start, pause, resume, end, extend, discard, dismissNotice } = useTimer.getState();
  const rules = useDayRules();
  const now = useNow(60_000);
  const today = useTodayKey();
  const go = useUI((s) => s.go);
  const preselect = useUI((s) => s.focusTaskId);

  const [minutes, setMinutes] = useState(settings.focus.focusMin);
  const [custom, setCustom] = useState(false);
  const [taskId, setTaskId] = useState<string>(preselect ?? '');
  const [subjectId, setSubjectId] = useState('');

  const openTasks = docs.tasks.filter((t) => t.status === 'todo');
  const subjectById = useMemo(() => new Map(docs.subjects.map((s) => [s.id, s])), [docs.subjects]);
  const suggestions = useMemo(() => suggestNext(docs.tasks, docs.exams, today, 3), [docs.tasks, docs.exams, today]);
  const queue = useMemo(() => buildQueue(docs.cards, today, { newPerDay: settings.newCardsPerDay, maxReviews: settings.maxReviewsPerDay }, docs.reviews.filter((r) => r.day === today && r.wasNew).length), [docs.cards, docs.reviews, today, settings]);
  const nextExam = docs.exams.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];

  const dayStart = dayStartMs(today, rules);
  const focusToday = Math.round(minutesByDay(docs.sessions, rules)[today] ?? 0);
  const sessionsToday = docs.sessions.filter((s) => s.kind === 'focus' && s.endedAt >= dayStart && s.activeMs >= 60_000).length;

  const state: 'idle' | 'running' | 'paused' | 'finished' | 'break' = !timer ? 'idle' : timer.status === 'finished' ? 'finished' : timer.kind === 'break' && timer.status === 'running' ? 'break' : timer.status;
  const used = timer ? activeMs(timer) : 0;
  const left = timer ? remainingMs(timer) : minutes * 60_000;
  const progress = timer ? used / timer.plannedMs : 0;
  const hour = new Date(now).getHours();
  const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', timeZone: rules.timeZone }).format(now);

  const linkedTask = timer?.taskId ? docs.tasks.find((t) => t.id === timer.taskId) : undefined;
  const caption = timer ? (timer.kind === 'break' ? 'Break' : (linkedTask?.title ?? timer.label ?? (timer.subjectId ? subjectById.get(timer.subjectId)?.name : 'Focus session'))) : 'Ready when you are';

  const chosenTask = openTasks.find((t) => t.id === taskId);

  const begin = () => {
    const task = chosenTask;
    start({ kind: 'focus', plannedMs: minutes * 60_000, taskId: task?.id, subjectId: task?.subjectId ?? (subjectId || undefined), label: task?.title });
  };
  const startBreak = (min: number) => {
    void end().then(() => useTimer.getState().start({ kind: 'break', plannedMs: min * 60_000 }));
  };

  // The just-finished block is not in history until the student ends it, so count it here.
  const justFinished = state === 'finished' && timer?.kind === 'focus' ? 1 : 0;
  const brk = nextBreak(completedInRow(docs.sessions, dayStart) + justFinished, settings.focus);

  const limitInputs = useLimitInputs();
  const limitRows = useMemo(() => {
    const eff = combineRules(docs.limits, limitInputs.policies, now);
    const platforms = allPlatforms(docs.platforms);
    const usage = aggregateUsage(limitInputs.measured, docs.manual_usage, today);
    const link = extensionLink(limitInputs.extensionLastSeen, now, limitInputs.bridgeUp, limitInputs.preview);
    return eff.filter((e) => !e.inactivePersonal || e.origins.length).map((e) => ({ e, name: platforms.find((p) => p.id === e.platform)?.name ?? e.platform, ev: evaluate(e, usage[e.platform] ?? { measuredSec: 0, selfReportedSec: 0 }, now, rules.timeZone, link, 80) }));
  }, [docs.limits, docs.platforms, docs.manual_usage, limitInputs, now, today, rules.timeZone]);

  return (
    <div>
      <header className="today-head">
        {settings.ambient && <Gyro className="today-gyro" size={150} />}
        <p className="label">{dateLabel}</p>
        <h1 className="display">
          {greeting(hour)}
          {settings.displayName ? `, ${settings.displayName}` : ''}.
        </h1>
        <p className="facts">
          <span><b>{openTasks.length}</b> open {openTasks.length === 1 ? 'task' : 'tasks'}</span>
          <span><b>{queue.dueReviews + Math.min(queue.newAvailable, settings.newCardsPerDay)}</b> cards to review</span>
          <span><b>{focusToday}</b> min focused today{sessionsToday ? ` · ${sessionsToday} ${sessionsToday === 1 ? 'session' : 'sessions'}` : ''}</span>
          {nextExam && <span>{nextExam.title} <b>{examCountdown(nextExam, today).label}</b></span>}
        </p>
      </header>

      {notice && (
        <Banner title="Session interrupted." actions={<Button size="sm" variant="quiet" onClick={dismissNotice}>Dismiss</Button>}>
          {notice} You can continue where you left off, or end it.
        </Banner>
      )}
      {persistError && <Banner tone="danger" title="Timer not saved.">{persistError}</Banner>}

      <div className="grid-2">
        <section aria-label="Focus timer">
          <Dial progress={state === 'idle' ? 0 : progress} state={state}>
            <p className="label" aria-hidden>{timer ? (timer.kind === 'break' ? 'Break' : state === 'paused' ? (timer.pauseReason === 'interrupted' ? 'Interrupted' : 'Paused') : state === 'finished' ? 'Complete' : 'Focus') : 'Focus'}</p>
            <p className="dial-time" role="timer" aria-live="off" aria-label={`${formatDuration(left)} remaining`}>{formatDuration(state === 'finished' ? 0 : left)}</p>
            <p className="dial-caption" title={caption}>{caption}</p>
          </Dial>
          <span className="sr-only" aria-live="polite">{state === 'finished' ? `${timer?.kind === 'break' ? 'Break' : 'Focus session'} complete.` : ''}</span>

          <div className="timer-controls">
            <AnimatePresence mode="wait" initial={false}>
              {state === 'idle' && (
                <motion.div key="idle" className="stack" style={{ alignItems: 'center' }} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                  <div className="timer-setup">
                    <div className="full cluster" style={{ justifyContent: 'center' }}>
                      {custom ? (
                        <Field label="Minutes">
                          <Input type="number" min={1} max={180} value={minutes} onChange={(e) => setMinutes(Math.max(1, Math.min(180, Number(e.target.value) || 1)))} style={{ width: 110 }} />
                        </Field>
                      ) : (
                        <Segmented label="Session length" value={minutes} onChange={(v) => setMinutes(v)} options={[...new Set([15, 25, 45, 60, settings.focus.focusMin])].sort((a, b) => a - b).map((m) => ({ value: m, label: `${m} min` }))} />
                      )}
                      <Button size="sm" variant="quiet" onClick={() => setCustom(!custom)}>{custom ? 'Presets' : 'Custom'}</Button>
                    </div>
                    <Field label="Working on" className="full">
                      <Select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                        <option value="">No specific task</option>
                        {openTasks.map((t) => (
                          <option key={t.id} value={t.id}>{t.title}{t.subjectId && subjectById.get(t.subjectId) ? ` — ${subjectById.get(t.subjectId)!.name}` : ''}</option>
                        ))}
                      </Select>
                    </Field>
                    {!taskId && docs.subjects.length > 0 && (
                      <Field label="Subject (optional)" className="full">
                        <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
                          <option value="">—</option>
                          {docs.subjects.filter((s) => !s.archived).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </Select>
                      </Field>
                    )}
                  </div>
                  <Button variant="primary" size="lg" onClick={begin}><Play size={18} aria-hidden /> Start {minutes} min</Button>
                  <p className="faint" style={{ fontSize: 'var(--fs-small)' }}>Time is only counted while the app is running — sleep and closed-app gaps are never counted.</p>
                </motion.div>
              )}
              {(state === 'running' || state === 'break') && timer && (
                <motion.div key="run" className="cluster" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                  <Button variant="primary" size="lg" onClick={() => pause()}><Pause size={18} aria-hidden /> Pause</Button>
                  <Button variant="quiet" onClick={() => extend(5)}><Plus size={16} aria-hidden /> 5 min</Button>
                  <Button variant="quiet" onClick={() => void end().then((r) => r && r.activeMs >= 10_000 && toast.ok(`Logged ${formatMinutes(Math.round(r.activeMs / 60_000))}.`))}><Square size={16} aria-hidden /> End</Button>
                </motion.div>
              )}
              {state === 'paused' && timer && (
                <motion.div key="paused" className="cluster" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                  <Button variant="primary" size="lg" onClick={() => resume()}><Play size={18} aria-hidden /> Resume</Button>
                  <Button variant="quiet" onClick={() => void end().then((r) => r && r.activeMs >= 10_000 && toast.ok(`Logged ${formatMinutes(Math.max(1, Math.round(r.activeMs / 60_000)))}.`))}><Square size={16} aria-hidden /> End & log</Button>
                  <Button variant="quiet" onClick={() => void discard()}><RotateCcw size={16} aria-hidden /> Discard</Button>
                </motion.div>
              )}
              {state === 'finished' && timer && (
                <motion.div key="fin" className="stack" style={{ alignItems: 'center' }} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                  <p className="display-italic" style={{ fontSize: 'var(--fs-h3)' }}>
                    {timer.kind === 'break' ? 'Break over.' : `${formatMinutes(Math.round(activeMs(timer) / 60_000))} of focus logged when you finish.`}
                  </p>
                  <div className="cluster" style={{ justifyContent: 'center' }}>
                    {timer.kind === 'focus' ? (
                      <>
                        <Button variant="primary" onClick={() => startBreak(brk.minutes)}><Coffee size={16} aria-hidden /> {brk.kind === 'long' ? 'Long' : 'Short'} break · {brk.minutes} min</Button>
                        <Button onClick={() => extend(5)}><Plus size={16} aria-hidden /> 5 more minutes</Button>
                        <Button variant="quiet" onClick={() => void end().then(() => toast.ok('Session saved.'))}>Finish</Button>
                      </>
                    ) : (
                      <Button variant="primary" onClick={() => void end()}><TimerReset size={16} aria-hidden /> Back to work</Button>
                    )}
                  </div>
                  {linkedTask && timer.kind === 'focus' && <p className="faint" style={{ fontSize: 'var(--fs-small)' }}>“{linkedTask.title}” stays open until you mark it done in Plan.</p>}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </section>

        <aside aria-label="Today's agenda">
          <div className="sec">
            <SectionHead index="01" title="Next up" />
            {suggestions.length === 0 ? (
              <div className="empty">
                <p className="display-italic">Nothing waiting.</p>
                <p>Add homework or a study task and it will show up here, ranked by what actually needs you first.</p>
                <Button onClick={() => go('plan')}><Plus size={16} aria-hidden /> Add a task</Button>
              </div>
            ) : (
              <ul className="rows">
                {suggestions.map(({ task, reasons }) => (
                  <li className="row" key={task.id}>
                    <div className="row-main suggest">
                      <span className="row-title">{task.title}</span>
                      <span className="why">{reasons.slice(0, 2).join(' · ')} · ~{formatMinutes(remainingMin(task))}</span>
                    </div>
                    <div className="row-end">
                      {task.subjectId && subjectById.get(task.subjectId) && <span className="chip"><i style={{ background: subjectById.get(task.subjectId)!.color }} />{subjectById.get(task.subjectId)!.name}</span>}
                      <Button size="sm" disabled={state !== 'idle'} onClick={() => { setTaskId(task.id); }} aria-label={`Focus on ${task.title}`}>Focus</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="sec">
            <SectionHead index="02" title="Review" />
            {docs.cards.length === 0 ? (
              <div className="empty">
                <p className="display-italic">No cards yet.</p>
                <p>Cards you make in the Library come back on a schedule, right before you would forget them.</p>
              </div>
            ) : (
              <div className="row">
                <div className="row-main">
                  <span className="row-title">{queue.ids.length === 0 ? 'All caught up' : `${queue.ids.length} card${queue.ids.length === 1 ? '' : 's'} ready`}</span>
                  <span className="row-sub">{queue.backlog > 0 ? `${queue.backlog} more are waiting – no need to clear them today.` : 'Short sessions work best.'}</span>
                </div>
                <Button size="sm" disabled={queue.ids.length === 0} onClick={() => { useUI.getState().set({ reviewMode: { kind: 'cards' } }); go('review'); }}>
                  <BookOpenCheck size={15} aria-hidden /> Start
                </Button>
              </div>
            )}
          </div>

          {limitRows.length > 0 && (
            <div className="sec">
              <SectionHead index="03" title="Limits today" />
              <ul className="rows">
                {limitRows.slice(0, 4).map(({ e, name, ev }) => (
                  <li className="row" key={e.platform}>
                    <div className="row-main">
                      <span className="row-title">{name}</span>
                      <span className="row-sub">
                        {ev.state === 'blocked' ? 'Blocked by your class' : ev.state === 'outside_hours' ? 'Outside allowed hours' : ev.limitMin === null ? 'No daily budget' : `${Math.round(ev.usedMin)} of ${ev.limitMin} min`}
                        {ev.measuredMin > 0 || ev.selfReportedMin > 0 ? ` · ${Math.round(ev.measuredMin)} measured${ev.selfReportedMin > 0 ? `, ${Math.round(ev.selfReportedMin)} self-reported` : ''}` : ''}
                      </span>
                    </div>
                    <Pill tone={ev.enforcement === 'enforced_in_browser' ? 'ok' : 'warn'} icon={ev.enforcement === 'enforced_in_browser' ? undefined : <ShieldAlert size={12} aria-hidden />}>
                      {ev.enforcement === 'enforced_in_browser' ? 'Enforced in browser' : 'Not enforced'}
                    </Pill>
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="quiet" onClick={() => go('limits')} style={{ marginTop: 'var(--s-2)' }}>Details <ArrowRight size={14} aria-hidden /></Button>
            </div>
          )}

          {nextExam && (
            <div className="sec">
              <SectionHead index={limitRows.length > 0 ? '04' : '03'} title="Ahead" />
              <div className="row">
                <CalendarClock size={18} aria-hidden className="faint" />
                <div className="row-main">
                  <span className="row-title">{nextExam.title}</span>
                  <span className="row-sub">{examCountdown(nextExam, today).label} · {nextExam.date}</span>
                </div>
                <Button size="sm" variant="quiet" onClick={() => go('plan')}>Plan</Button>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
