import { useMemo } from 'react';
import { useData } from '../../data/store';
import { useDayRules, useTodayKey } from '../../state/selectors';
import { Empty, SectionHead } from '../../design/ui';
import { minutesByDay } from '../../domain/timer';
import { examCountdown, weeklyReview } from '../../domain/planner';
import { dayKey, formatMinutes } from '../../domain/time';

export function WeeklyReviewTab() {
  const docs = useData((s) => s.docs);
  const rules = useDayRules();
  const today = useTodayKey();
  const r = useMemo(() => weeklyReview(docs.tasks, minutesByDay(docs.sessions, rules), docs.exams, today, (ms) => dayKey(ms, rules)), [docs.tasks, docs.sessions, docs.exams, rules, today]);
  const max = Math.max(30, ...Object.values(r.focusMinutesByDay));
  const label = (k: string) => new Date(`${k}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
  const nothing = r.completed.length === 0 && r.focusMinutesTotal === 0 && r.carryOver.length === 0;

  if (nothing) return <Empty title="A quiet week so far.">Once you finish tasks or run focus sessions, this page summarises the week — what got done, what carries over, and how long things really took.</Empty>;

  return (
    <div className="grid-even">
      <div>
        <div className="sec">
          <SectionHead index="01" title="Focused time" />
          <div className="bars" role="img" aria-label={`Focus minutes per day: ${Object.entries(r.focusMinutesByDay).map(([d, m]) => `${label(d)} ${m}`).join(', ')}`}>
            {Object.entries(r.focusMinutesByDay).map(([d, m]) => (
              <div className="bar-wrap" key={d}><span className="label">{m || ''}</span><div className="bar" style={{ height: `${(m / max) * 100}%`, opacity: d === today ? 1 : 0.7 }} /><span className="label">{label(d)}</span></div>
            ))}
          </div>
          <p className="muted"><b style={{ color: 'var(--text)' }}>{formatMinutes(r.focusMinutesTotal)}</b> of focus this week. Only time the timer actually ran is counted.</p>
        </div>
        {r.accuracy && (
          <div className="sec">
            <SectionHead index="02" title="Your estimates" />
            <p>Across {r.accuracy.samples} finished tasks, things take about <b>{r.accuracy.ratio}×</b> your estimate. {r.accuracy.ratio > 1.15 ? 'Planning a little extra time will make your days feel less rushed.' : r.accuracy.ratio < 0.85 ? 'You tend to finish early — you can plan a bit more into a day.' : 'Your estimates are well calibrated.'}</p>
          </div>
        )}
      </div>
      <div>
        <div className="sec">
          <SectionHead index="03" title={`Done · ${r.completed.length}`} />
          {r.completed.length === 0 ? <p className="faint" style={{ padding: 'var(--s-3) 0' }}>Nothing marked done yet this week.</p> : <ul className="rows">{r.completed.map((t) => <li className="row" key={t.id}><span className="row-main"><span className="row-title">{t.title}</span><span className="row-sub">{t.actualMin ? `${formatMinutes(t.actualMin)} spent` : 'no time tracked'}</span></span></li>)}</ul>}
        </div>
        <div className="sec">
          <SectionHead index="04" title={`Carrying over · ${r.carryOver.length}`} />
          {r.carryOver.length === 0 ? <p className="faint" style={{ padding: 'var(--s-3) 0' }}>All clear.</p> : <ul className="rows">{r.carryOver.map((t) => <li className="row" key={t.id}><span className="row-main"><span className="row-title">{t.title}</span><span className="row-sub">{t.due ? `due ${t.due}` : `planned ${t.plannedDay}`}</span></span></li>)}</ul>}
        </div>
        {r.upcomingExams.length > 0 && (
          <div className="sec">
            <SectionHead index="05" title="Coming up" />
            <ul className="rows">{r.upcomingExams.map((e) => <li className="row" key={e.id}><span className="row-main"><span className="row-title">{e.title}</span><span className="row-sub">{e.date}</span></span><span className="label">{examCountdown(e, today).label}</span></li>)}</ul>
          </div>
        )}
      </div>
    </div>
  );
}
