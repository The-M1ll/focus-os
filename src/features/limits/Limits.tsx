import { useMemo, useState } from 'react';
import { Copy, Pause, Pencil, Play, Plus, ShieldAlert, ShieldCheck, Clock3 } from 'lucide-react';
import { useData } from '../../data/store';
import { useEnv } from '../../state/env';
import { useUI } from '../../app/ui-state';
import { useDayRules, useNow, useTodayKey } from '../../state/selectors';
import { attempt, Button, Empty, Meter, Pill, SectionHead, toast } from '../../design/ui';
import { aggregateUsage, allPlatforms, combineRules, evaluate, extensionLink, type LimitState } from '../../domain/limits';
import { addDays, rangeDays } from '../../domain/time';
import { useLimitInputs } from './useLimitInputs';
import { CustomPlatformDialog, ManualUsageDialog, PersonalLimitDialog } from './LimitDialogs';
import './limits.css';

const STATE_PILL: Record<LimitState, { text: string; tone?: 'ok' | 'warn' | 'danger' | 'info' }> = {
  ok: { text: 'Within budget', tone: 'ok' },
  warning: { text: 'Nearly used up', tone: 'warn' },
  exhausted: { text: 'Budget used up', tone: 'danger' },
  outside_hours: { text: 'Outside allowed hours', tone: 'warn' },
  blocked: { text: 'Blocked by class', tone: 'danger' },
  no_budget: { text: 'No daily budget', tone: 'info' },
};

const LINK_PILL = {
  connected: { text: 'Extension connected', tone: 'ok' as const },
  stale: { text: 'Extension silent', tone: 'warn' as const },
  never: { text: 'Extension not connected', tone: 'warn' as const },
  unavailable: { text: 'Bridge unavailable', tone: 'danger' as const },
  preview: { text: 'Desktop app only', tone: undefined },
};

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.ok(`${what} copied.`);
  } catch {
    toast.error('Could not copy automatically. Select the text and copy it manually.');
  }
}

export function Limits() {
  const docs = useData((s) => s.docs);
  const rules = useDayRules();
  const now = useNow(15_000);
  const today = useTodayKey();
  const inputs = useLimitInputs();
  const bridge = useEnv((s) => s.bridge);
  const classes = useEnv((s) => s.classes);
  const syncByClass = useEnv((s) => s.syncByClass);
  const [editId, setEditId] = useState<string | null | undefined>(undefined);
  const [manualFor, setManualFor] = useState<string | null | undefined>(undefined);
  const [custom, setCustom] = useState(false);
  const [showToken, setShowToken] = useState(false);

  const platforms = useMemo(() => allPlatforms(docs.platforms), [docs.platforms]);
  const link = extensionLink(inputs.extensionLastSeen, now, inputs.bridgeUp, inputs.preview);
  const effective = useMemo(() => combineRules(docs.limits, inputs.policies, now), [docs.limits, inputs.policies, now]);
  const usage = useMemo(() => aggregateUsage(inputs.measured, docs.manual_usage, today), [inputs.measured, docs.manual_usage, today]);
  const personalAllowed = inputs.policies.every((p) => p.allowPersonalLimits);
  const unconfigured = platforms.filter((p) => !effective.some((e) => e.platform === p.id));
  const nameOf = (id: string) => platforms.find((p) => p.id === id)?.name ?? id;

  const last7 = rangeDays(addDays(today, -6), 7);
  const histPlatforms = useMemo(() => {
    const ids = new Set<string>([...inputs.measured.map((m) => m.platform), ...docs.manual_usage.map((m) => m.platform), ...effective.map((e) => e.platform)]);
    return [...ids].sort();
  }, [inputs.measured, docs.manual_usage, effective]);

  const pause = (id: string, until: number | undefined) => {
    const l = docs.limits.find((x) => x.id === id);
    if (l) void attempt(() => useData.getState().put('limits', { ...l, pausedUntil: until })).then((r) => r.ok && toast.ok(until ? 'Your rule is paused.' : 'Your rule is active again.'));
  };

  return (
    <div>
      <header className="page-head">
        <div>
          <p className="label">Digital life control</p>
          <h1 className="display">Limits</h1>
          <p>Set how much time distractions get. Every number here says where it came from, and every rule says whether it is actually being enforced.</p>
        </div>
        <div className="cluster">
          <Button onClick={() => setManualFor(null)}><Clock3 size={15} aria-hidden /> Add time I spent</Button>
          <Button variant="primary" onClick={() => setEditId(null)}><Plus size={16} aria-hidden /> Set a limit</Button>
        </div>
      </header>

      <div className="sec">
        <SectionHead index="01" title="What is actually enforced" />
        <ul className="rows">
          <li className="row">
            {link === 'connected' ? <ShieldCheck size={20} aria-hidden style={{ color: 'var(--accent)' }} /> : <ShieldAlert size={20} aria-hidden style={{ color: 'var(--warn)' }} />}
            <div className="row-main">
              <span className="row-title">Websites in your browser</span>
              <span className="row-sub">{link === 'connected' ? 'The FOCUS OS extension is checking in, measuring time on the page you are looking at, and blocking when a limit is reached.' : link === 'preview' ? 'This is the browser preview. Measuring and blocking need the desktop app and the browser extension; your rules are still saved here.' : link === 'unavailable' ? (bridge?.error ?? 'The desktop app’s local bridge for the extension is not running, so nothing can be enforced.') : link === 'stale' ? 'The extension was connected earlier but has not checked in for over two minutes.' : 'No extension has connected yet. Until one does, limits below are saved but nothing blocks or measures anything.'}</span>
            </div>
            <Pill tone={LINK_PILL[link].tone}>{LINK_PILL[link].text}</Pill>
          </li>
          <li className="row">
            <ShieldAlert size={20} aria-hidden className="faint" />
            <div className="row-main">
              <span className="row-title">Apps outside the browser</span>
              <span className="row-sub">Not supported in this version. Time in desktop and phone apps is never measured automatically; you can add it yourself and it will be labelled self-reported.</span>
            </div>
            <Pill>Unavailable</Pill>
          </li>
        </ul>
        {link !== 'connected' && bridge?.listening && (
          <details style={{ marginTop: 'var(--s-3)' }} open={link === 'never'}>
            <summary className="label" style={{ cursor: 'pointer' }}>Connect the browser extension</summary>
            <ol className="stack" style={{ margin: 'var(--s-3) 0 0', paddingLeft: '1.2em' }}>
              <li>In Chrome or Edge open <code>chrome://extensions</code>, switch on Developer mode and choose <b>Load unpacked</b>, then select the <code>extension</code> folder of FOCUS OS.</li>
              <li>Open the extension’s options and paste these two values. The token is a password for this computer only — don’t share it.</li>
            </ol>
            <div className="stack" style={{ marginTop: 'var(--s-3)' }}>
              <div className="copy-box"><code aria-label="Bridge address">http://{bridge.address}</code><Button size="sm" onClick={() => void copy(`http://${bridge.address}`, 'Address')}><Copy size={14} aria-hidden /> Copy</Button></div>
              <div className="copy-box"><code aria-label="Bridge token">{showToken ? bridge.token : '•'.repeat(24)}</code><Button size="sm" variant="quiet" onClick={() => setShowToken(!showToken)}>{showToken ? 'Hide' : 'Show'}</Button><Button size="sm" onClick={() => void copy(bridge.token, 'Token')}><Copy size={14} aria-hidden /> Copy</Button></div>
            </div>
          </details>
        )}
      </div>

      <div className="sec">
        <SectionHead index="02" title="Today" />
        {effective.length === 0 ? (
          <Empty title="No limits yet." action={<Button variant="primary" onClick={() => setEditId(null)}>Set your first limit</Button>}>Pick a platform and give it a daily budget. If you join a class, its rules appear here too, clearly marked.</Empty>
        ) : (
          <div role="list">
            {effective.map((e) => {
              const u = usage[e.platform] ?? { measuredSec: 0, selfReportedSec: 0 };
              const personal = docs.limits.find((l) => l.platform === e.platform);
              const warn = personal?.warnAtPct ?? 80;
              const ev = evaluate(e, u, now, rules.timeZone, link, warn);
              const pill = STATE_PILL[ev.state];
              const paused = personal?.pausedUntil && personal.pausedUntil > now;
              return (
                <div className="lim-row" role="listitem" key={e.platform}>
                  <div>
                    <p className="lim-name">{nameOf(e.platform)}</p>
                    <div className="cluster" style={{ marginTop: 6 }}>
                      {e.origins.map((o, i) => <Pill key={i} tone={o.origin === 'class' ? 'info' : undefined}>{o.origin === 'class' ? `Class · ${o.label}` : o.label}</Pill>)}
                      {e.inactivePersonal && <Pill tone="warn" title={e.inactivePersonal}>Your rule: {e.inactivePersonal.toLowerCase()}</Pill>}
                    </div>
                  </div>
                  <div className="lim-detail">
                    {ev.limitMin !== null && <Meter value={ev.usedMin} max={Math.max(1, ev.limitMin)} tone={ev.state === 'exhausted' ? 'danger' : ev.state === 'warning' ? 'warn' : undefined} label={`${nameOf(e.platform)} used ${Math.round(ev.usedMin)} of ${ev.limitMin} minutes`} mark={(ev.limitMin * warn) / 100} />}
                    <div className="lim-nums">
                      <span>Measured <b>{Math.round(ev.measuredMin)} min</b></span>
                      <span>Self-reported <b>{Math.round(ev.selfReportedMin)} min</b></span>
                      {ev.limitMin !== null && <span>Budget <b>{ev.limitMin} min</b></span>}
                      {ev.remainingMin !== null && ev.state !== 'blocked' && <span>Left <b>{Math.round(ev.remainingMin)} min</b></span>}
                    </div>
                    <span className="row-sub">{ev.enforcementNote}</span>
                  </div>
                  <div className="stack" style={{ alignItems: 'flex-end', gap: 8 }}>
                    <Pill tone={pill.tone}>{pill.text}</Pill>
                    <Pill tone={ev.enforcement === 'enforced_in_browser' ? 'ok' : 'warn'}>{ev.enforcement === 'enforced_in_browser' ? 'Enforced in browser' : 'Not enforced'}</Pill>
                    <div className="cluster" style={{ gap: 4 }}>
                      <Button size="sm" variant="quiet" aria-label={`Add time spent on ${nameOf(e.platform)}`} onClick={() => setManualFor(e.platform)}><Plus size={13} aria-hidden /> Time</Button>
                      <Button size="sm" variant="quiet" aria-label={`Edit your rule for ${nameOf(e.platform)}`} onClick={() => setEditId(e.platform)}><Pencil size={13} aria-hidden /> {personal ? 'Edit' : 'Add rule'}</Button>
                      {personal && personalAllowed && (paused
                        ? <Button size="sm" variant="quiet" onClick={() => pause(personal.id, undefined)}><Play size={13} aria-hidden /> Resume</Button>
                        : <Button size="sm" variant="quiet" onClick={() => pause(personal.id, now + 3_600_000)}><Pause size={13} aria-hidden /> Pause 1 h</Button>)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {unconfigured.length > 0 && (
          <p className="muted" style={{ marginTop: 'var(--s-4)' }}>
            Not limited:{' '}
            {unconfigured.map((p, i) => <span key={p.id}>{i > 0 && ', '}<button className="btn btn-quiet btn-sm" style={{ height: 'auto', padding: '0 4px' }} onClick={() => setEditId(p.id)}>{p.name}</button></span>)}
            {' · '}
            <button className="btn btn-quiet btn-sm" style={{ height: 'auto', padding: '0 4px' }} onClick={() => setCustom(true)}>+ website</button>
          </p>
        )}
      </div>

      <div className="grid-even">
        <div className="sec">
          <SectionHead index="03" title="Last seven days" />
          {histPlatforms.length === 0 ? <p className="faint" style={{ padding: 'var(--s-3) 0' }}>No usage recorded yet.</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="hist">
                <caption className="sr-only">Minutes per platform per day. Measured by the extension / self-reported.</caption>
                <thead><tr><th scope="col">Platform</th>{last7.map((d) => <th scope="col" key={d}>{d.slice(5)}</th>)}</tr></thead>
                <tbody>
                  {histPlatforms.map((pid) => (
                    <tr key={pid}>
                      <th scope="row" style={{ color: 'var(--text)', fontFamily: 'var(--font-ui)', letterSpacing: 0, textTransform: 'none', fontSize: 'var(--fs-small)' }}>{nameOf(pid)}</th>
                      {last7.map((d) => {
                        const m = Math.round(inputs.measured.filter((x) => x.day === d && x.platform === pid).reduce((a, x) => a + x.seconds, 0) / 60);
                        const s = docs.manual_usage.filter((x) => x.day === d && x.platform === pid).reduce((a, x) => a + x.minutes, 0);
                        return <td className="n" key={d}>{m || s ? <>{m}{s ? <span className="faint"> +{s}</span> : null}</> : <span className="faint">–</span>}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="faint" style={{ fontSize: 'var(--fs-small)', marginTop: 8 }}>Minutes. Plain numbers are measured by the browser extension; “+n” is self-reported.</p>
            </div>
          )}
        </div>
        <div className="sec">
          <SectionHead index="04" title="Classes & day boundary" />
          {classes.length === 0 ? <p className="faint" style={{ padding: 'var(--s-3) 0' }}>You are not in a class, so only your own rules apply.</p> : (
            <ul className="rows">
              {classes.filter((c) => c.membership.status === 'active').map((c) => {
                const st = syncByClass[c.membership.class_id];
                const p = inputs.policies.find((x) => x.classId === c.membership.class_id);
                return (
                  <li className="row" key={c.membership.class_id}>
                    <span className="row-main"><span className="row-title">{c.membership.class_name}</span><span className="row-sub">{p ? `Policy revision ${p.revision} · ${p.limits.length} rule${p.limits.length === 1 ? '' : 's'}` : 'No policy received yet'}</span></span>
                    <Pill tone={st?.state === 'live' ? 'ok' : 'warn'}>{st?.state === 'live' ? 'Live' : 'Last known policy'}</Pill>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="muted" style={{ marginTop: 'var(--s-4)' }}>Your day resets at <b>{String(rules.resetHour).padStart(2, '0')}:00</b> in <b>{rules.timeZone}</b>. <button className="btn btn-quiet btn-sm" style={{ height: 'auto', padding: '0 4px' }} onClick={() => useUI.getState().go('settings')}>Change</button></p>
        </div>
      </div>

      <PersonalLimitDialog open={editId !== undefined} platformId={editId ?? null} onClose={() => setEditId(undefined)} personalAllowed={personalAllowed} blockedByClass={!!effective.find((e) => e.platform === editId)?.blocked} />
      <ManualUsageDialog open={manualFor !== undefined} platformId={manualFor ?? null} onClose={() => setManualFor(undefined)} />
      <CustomPlatformDialog open={custom} onClose={() => setCustom(false)} />
    </div>
  );
}
