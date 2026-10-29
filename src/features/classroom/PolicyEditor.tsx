import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useData } from '../../data/store';
import { newId } from '../../data/ids';
import { attempt, Button, Field, Input, Pill, Select, Switch, toast } from '../../design/ui';
import { allPlatforms, type ClassRule } from '../../domain/limits';
import { getClassApi, type PolicyPayload, type StoredPolicy } from '../../data/classApi';

interface RuleRow {
  key: string;
  platform: string;
  mode: 'budget' | 'blocked' | 'hours';
  minutes: number;
  start: string;
  end: string;
}
interface GoalRow { key: string; id: string; title: string; hours: number }

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };

function fromPolicy(p: PolicyPayload | undefined): { rules: RuleRow[]; goals: GoalRow[]; allowPersonal: boolean } {
  if (!p) return { rules: [], goals: [], allowPersonal: true };
  return {
    allowPersonal: p.allow_personal_limits,
    goals: p.study_goals.map((g) => ({ key: g.id, id: g.id, title: g.title, hours: Math.round((g.target_minutes_per_week / 60) * 10) / 10 })),
    rules: p.limits.map((l) => {
      const w = l.allowed_windows[0];
      return { key: l.platform, platform: l.platform, mode: l.blocked ? 'blocked' : l.daily_minutes === null ? 'hours' : 'budget', minutes: l.daily_minutes ?? 30, start: hhmm(w?.start_min ?? 900), end: hhmm(w?.end_min ?? 1200) } as RuleRow;
    }),
  };
}

/** Pure conversion + validation (mirrors the Rust validation; the host re-validates anyway). */
export function toPayload(rules: RuleRow[], goals: GoalRow[], allowPersonal: boolean): { payload?: PolicyPayload; error?: string } {
  const seen = new Set<string>();
  const limits: ClassRule[] = [];
  for (const r of rules) {
    if (seen.has(r.platform)) return { error: `“${r.platform}” appears twice.` };
    seen.add(r.platform);
    if (r.mode === 'blocked') limits.push({ platform: r.platform, blocked: true, daily_minutes: null, allowed_windows: [] });
    else {
      if (r.mode === 'budget' && !(r.minutes >= 0 && r.minutes <= 1440)) return { error: 'Daily minutes must be between 0 and 1440.' };
      const hours = r.mode === 'hours';
      if (hours && toMin(r.start) >= toMin(r.end)) return { error: 'An allowed-hours rule must end after it starts.' };
      limits.push({ platform: r.platform, blocked: false, daily_minutes: r.mode === 'budget' ? Math.round(r.minutes) : null, allowed_windows: hours ? [{ days: [], start_min: toMin(r.start), end_min: toMin(r.end) }] : [] });
    }
  }
  const study_goals = goals.filter((g) => g.title.trim()).map((g) => ({ id: g.id, title: g.title.trim(), target_minutes_per_week: Math.round(g.hours * 60) }));
  if (study_goals.some((g) => g.target_minutes_per_week > 10080)) return { error: 'A weekly goal cannot exceed a week.' };
  return { payload: { limits, study_goals, allow_personal_limits: allowPersonal, progress_sharing: 'none' } };
}

export function PolicyEditor({ classId, current, onPublished }: { classId: string; current: StoredPolicy | null; onPublished: () => void }) {
  const platforms = allPlatforms(useData((s) => s.docs.platforms));
  const initial = useMemo(() => fromPolicy(current?.envelope.payload), [current]);
  const [rules, setRules] = useState<RuleRow[]>(initial.rules);
  const [goals, setGoals] = useState<GoalRow[]>(initial.goals);
  const [allow, setAllow] = useState(initial.allowPersonal);
  const [busy, setBusy] = useState(false);

  const built = toPayload(rules, goals, allow);
  const dirty = JSON.stringify(built.payload ?? null) !== JSON.stringify(current?.envelope.payload ?? { limits: [], study_goals: [], allow_personal_limits: true, progress_sharing: 'none' });
  const nextRev = (current?.envelope.revision ?? 0) + 1;

  const publish = async () => {
    if (!built.payload) return toast.warn(built.error ?? 'Fix the highlighted problem first.');
    setBusy(true);
    const r = await attempt(() => getClassApi().publish(classId, built.payload!), 'Could not publish');
    setBusy(false);
    if (r.ok) { toast.ok(`Published revision ${r.value}. Connected devices update immediately; others on reconnect.`); onPublished(); }
  };

  const used = new Set(rules.map((r) => r.platform));
  const free = platforms.filter((p) => !used.has(p.id));

  return (
    <div>
      <div className="stack">
        <Switch label="Members may add their own stricter limits" checked={allow} onChange={setAllow} description="Personal rules can only tighten class rules, never loosen them." />
        <div>
          <p className="label" style={{ marginBottom: 6 }}>Platform rules</p>
          {rules.length === 0 && <p className="faint" style={{ padding: 'var(--s-3) 0' }}>No platform rules. Members are only limited by what they set themselves.</p>}
          {rules.map((r, i) => (
            <div className="policy-row" key={r.key}>
              <Field label="Platform"><Select value={r.platform} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, platform: e.target.value } : x)))}>
                {[platforms.find((p) => p.id === r.platform) ?? { id: r.platform, name: r.platform }, ...free].map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select></Field>
              <Field label="Rule"><Select value={r.mode} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, mode: e.target.value as RuleRow['mode'] } : x)))}>
                <option value="budget">Daily budget</option><option value="hours">Allowed hours</option><option value="blocked">Blocked</option>
              </Select></Field>
              {r.mode === 'budget' && <Field label="Minutes per day"><Input type="number" min={0} max={1440} value={r.minutes} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, minutes: Number(e.target.value) } : x)))} /></Field>}
              {r.mode === 'hours' && <div className="cluster"><Field label="From"><Input type="time" value={r.start} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} /></Field><Field label="Until"><Input type="time" value={r.end} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} /></Field></div>}
              {r.mode === 'blocked' && <p className="muted" style={{ alignSelf: 'center' }}>Not available at any time</p>}
              <Button variant="quiet" size="sm" aria-label={`Remove rule for ${r.platform}`} onClick={() => setRules(rules.filter((_, j) => j !== i))}><Trash2 size={15} aria-hidden /></Button>
            </div>
          ))}
          <Button size="sm" style={{ marginTop: 'var(--s-3)' }} disabled={free.length === 0} onClick={() => setRules([...rules, { key: newId('r'), platform: free[0]!.id, mode: 'budget', minutes: 30, start: '15:00', end: '20:00' }])}><Plus size={14} aria-hidden /> Add platform rule</Button>
        </div>
        <div>
          <p className="label" style={{ marginBottom: 6 }}>Class study goals</p>
          {goals.map((g, i) => (
            <div className="policy-row" key={g.key} style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr) auto' }}>
              <Field label="Goal"><Input value={g.title} maxLength={120} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} /></Field>
              <Field label="Hours per week"><Input type="number" min={0} step={0.5} value={g.hours} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, hours: Number(e.target.value) } : x)))} /></Field>
              <Button variant="quiet" size="sm" aria-label="Remove goal" onClick={() => setGoals(goals.filter((_, j) => j !== i))}><Trash2 size={15} aria-hidden /></Button>
            </div>
          ))}
          <Button size="sm" style={{ marginTop: 'var(--s-3)' }} onClick={() => setGoals([...goals, { key: newId('g'), id: newId('g'), title: '', hours: 2 }])}><Plus size={14} aria-hidden /> Add goal</Button>
          <p className="faint" style={{ fontSize: 'var(--fs-small)', marginTop: 6 }}>Goals are shown to members as a target. Progress toward them is not collected.</p>
        </div>
        <div className="cluster" style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--s-4)' }}>
          <Button variant="primary" busy={busy} disabled={!dirty || !built.payload} onClick={() => void publish()}>Publish revision {nextRev}</Button>
          {built.error ? <Pill tone="danger">{built.error}</Pill> : dirty ? <Pill tone="warn">Unpublished changes</Pill> : <Pill tone="ok">Matches revision {current?.envelope.revision ?? 0}</Pill>}
        </div>
      </div>
    </div>
  );
}
