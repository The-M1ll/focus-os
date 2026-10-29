import { useState } from 'react';
import { useData } from '../../data/store';
import { newId } from '../../data/ids';
import { useTodayKey } from '../../state/selectors';
import { attempt, Banner, Button, Dialog, Field, Input, Select, Switch, toast } from '../../design/ui';
import { allPlatforms } from '../../domain/limits';
import { appDisplayName, appSlugOf, isAppRule } from '../../domain/apps';
import type { PersonalLimit } from '../../domain/schemas';
import { isDayKey } from '../../domain/time';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };

export function PersonalLimitDialog(props: { open: boolean; platformId: string | null; onClose: () => void; personalAllowed: boolean; blockedByClass: boolean }) {
  return props.open ? <PersonalLimitForm {...props} /> : null;
}

function PersonalLimitForm({ platformId, onClose, personalAllowed, blockedByClass }: { platformId: string | null; onClose: () => void; personalAllowed: boolean; blockedByClass: boolean }) {
  const docs = useData((s) => s.docs);
  const isApp = !!platformId && isAppRule(platformId);
  // An app rule is for exactly one app: the platform list is that app, never the websites.
  const platforms = isApp ? [{ id: platformId, name: appDisplayName(appSlugOf(platformId)) }] : allPlatforms(docs.platforms);
  const existing = docs.limits.find((l) => l.platform === platformId) ?? null;
  const [f, setF] = useState(() => existing
    ? { platform: existing.platform, hasBudget: existing.dailyMinutes !== null, minutes: existing.dailyMinutes ?? 30, days: existing.days, hasHours: existing.allowedStart !== null, start: hhmm(existing.allowedStart ?? 900), end: hhmm(existing.allowedEnd ?? 1200), warn: existing.warnAtPct, enabled: existing.enabled }
    : { platform: platformId ?? platforms[0]?.id ?? '', hasBudget: true, minutes: 30, days: [0, 1, 2, 3, 4, 5, 6], hasHours: false, start: '15:00', end: '20:00', warn: 80, enabled: true });
  const [err, setErr] = useState<{ minutes?: string; hours?: string; days?: string }>({});

  const save = async () => {
    const e: typeof err = {};
    if (f.hasBudget && !(f.minutes >= 0 && f.minutes <= 1440)) e.minutes = 'Minutes must be between 0 and 1440.';
    if (f.hasHours && toMin(f.start) >= toMin(f.end)) e.hours = 'The end time must be after the start time.';
    if (f.days.length === 0) e.days = 'Pick at least one day, or switch the rule off.';
    setErr(e);
    if (Object.keys(e).length) return;
    const doc: PersonalLimit = {
      id: existing?.id ?? newId('lim'),
      platform: f.platform,
      dailyMinutes: f.hasBudget ? Math.round(f.minutes) : null,
      days: f.days,
      allowedStart: f.hasHours ? toMin(f.start) : null,
      allowedEnd: f.hasHours ? toMin(f.end) : null,
      warnAtPct: f.warn,
      enabled: f.enabled,
      pausedUntil: existing?.pausedUntil,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    const r = await attempt(() => useData.getState().put('limits', doc), 'Could not save the rule');
    if (r.ok) { toast.ok('Rule saved.'); onClose(); }
  };

  return (
    <Dialog open onClose={onClose} title={existing ? 'Edit your rule' : isApp ? `Limit ${platforms[0]!.name}` : 'Set a limit'} description="Your own rule can only make things stricter than a class rule, never looser." footer={<>
      {existing && <Button variant="danger" onClick={() => void attempt(() => useData.getState().remove('limits', existing.id)).then((r) => { if (r.ok) { toast.ok('Rule removed.'); onClose(); } })}>Remove</Button>}
      <Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()} disabled={!personalAllowed}>Save rule</Button></>}>
      {!personalAllowed && <Banner title="Personal limits are switched off by your class.">You can see the rule below but it will not take effect until your class allows it.</Banner>}
      {blockedByClass && <Banner tone="info" title={isApp ? 'This app is blocked by your class.' : 'This platform is blocked by your class.'}>A personal rule can’t loosen that, so it would have no effect.</Banner>}
      <div className="stack">
        <Field label={isApp ? 'App' : 'Platform'}><Select value={f.platform} disabled={!!existing || isApp} onChange={(e) => setF({ ...f, platform: e.target.value })}>{platforms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Switch label="Daily time budget" checked={f.hasBudget} onChange={(v) => setF({ ...f, hasBudget: v })} />
        {f.hasBudget && <Field label="Minutes per day" error={err.minutes}><Input type="number" min={0} max={1440} step={5} value={f.minutes} onChange={(e) => setF({ ...f, minutes: Number(e.target.value) })} /></Field>}
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label" style={{ fontSize: 'var(--fs-small)', color: 'var(--text-2)', marginBottom: 6 }}>Allowed days</legend>
          <div className="daypick">
            {DAYS.map((d, i) => <label key={d}><input type="checkbox" checked={f.days.includes(i)} onChange={(e) => setF({ ...f, days: e.target.checked ? [...f.days, i].sort() : f.days.filter((x) => x !== i) })} aria-label={d} /><span aria-hidden>{d}</span></label>)}
          </div>
          {err.days && <span className="error" role="alert">{err.days}</span>}
        </fieldset>
        <Switch label="Only allow within certain hours" checked={f.hasHours} onChange={(v) => setF({ ...f, hasHours: v })} />
        {f.hasHours && (
          <div className="cluster">
            <Field label="From"><Input type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
            <Field label="Until" error={err.hours}><Input type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field>
          </div>
        )}
        {f.hasBudget && <Field label={`Warn me at ${f.warn}% of the budget`}><input type="range" min={10} max={100} step={5} value={f.warn} onChange={(e) => setF({ ...f, warn: Number(e.target.value) })} aria-label="Warning threshold percent" /></Field>}
        <Switch label="Rule is active" checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} />
      </div>
    </Dialog>
  );
}

export function ManualUsageDialog(props: { open: boolean; platformId: string | null; onClose: () => void }) {
  return props.open ? <ManualUsageForm platformId={props.platformId} onClose={props.onClose} /> : null;
}

function ManualUsageForm({ platformId, onClose }: { platformId: string | null; onClose: () => void }) {
  const docs = useData((s) => s.docs);
  const today = useTodayKey();
  const platforms = allPlatforms(docs.platforms);
  const [platform, setPlatform] = useState(platformId ?? platforms[0]?.id ?? '');
  const [minutes, setMinutes] = useState(15);
  const [day, setDay] = useState(today);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    if (!(minutes >= 1 && minutes <= 1440)) return setErr('Enter between 1 and 1440 minutes.');
    if (!isDayKey(day)) return setErr('Pick a valid date.');
    const r = await attempt(() => useData.getState().put('manual_usage', { id: newId('use'), day, platform, minutes: Math.round(minutes), at: Date.now() }));
    if (r.ok) { toast.ok('Added. It is shown as self-reported, separate from measured time.'); onClose(); }
  };
  return (
    <Dialog open onClose={onClose} title="Add time I spent" description="For time outside the browser or before the extension was installed. This is your own number and is always labelled self-reported." footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Add</Button></>}>
      <div className="stack">
        <Field label="Platform"><Select value={platform} onChange={(e) => setPlatform(e.target.value)}>{platforms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label="Minutes" error={err}><Input type="number" min={1} max={1440} value={minutes} onChange={(e) => { setMinutes(Number(e.target.value)); setErr(null); }} autoFocus /></Field>
        <Field label="Day"><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

export function CustomPlatformDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <CustomPlatformForm onClose={onClose} /> : null;
}

function CustomPlatformForm({ onClose }: { onClose: () => void }) {
  const platforms = allPlatforms(useData((s) => s.docs.platforms));
  const [name, setName] = useState('');
  const [domains, setDomains] = useState('');
  const [err, setErr] = useState<{ name?: string; domains?: string }>({});
  const save = async () => {
    const e: typeof err = {};
    const list = domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')).filter(Boolean);
    if (!name.trim()) e.name = 'Give it a name.';
    if (list.length === 0 || list.some((d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d))) e.domains = 'Enter one or more domains like example.com.';
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    if (!id || platforms.some((p) => p.id === id)) e.name = e.name ?? 'That name is already used.';
    setErr(e);
    if (Object.keys(e).length) return;
    const r = await attempt(() => useData.getState().put('platforms', { id, name: name.trim(), domains: list }));
    if (r.ok) { toast.ok(`Added ${name.trim()}.`); onClose(); }
  };
  return (
    <Dialog open onClose={onClose} title="Add a website" description="Websites are measured and limited through the browser extension." footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Add website</Button></>}>
      <div className="stack">
        <Field label="Name" error={err.name}><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={40} /></Field>
        <Field label="Domains" error={err.domains} hint="Separate several with spaces or commas."><Input value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="news.example.com" /></Field>
      </div>
    </Dialog>
  );
}
