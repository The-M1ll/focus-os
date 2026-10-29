import { useEffect, useMemo, useState } from 'react';
import { Gamepad2, Monitor, Pencil, Plus, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useData } from '../../data/store';
import { useEnv } from '../../state/env';
import { getBackend } from '../../data/backend';
import { useDayRules, useNow, useTodayKey } from '../../state/selectors';
import { attempt, Banner, Button, Dialog, Empty, Field, Input, Meter, Pill, SectionHead, Segmented } from '../../design/ui';
import { combineRules, evaluate, type LimitState } from '../../domain/limits';
import { addDays, rangeDays } from '../../domain/time';
import { APPS_LINK_TEXT, appDisplayName, appRuleId, appSlug, appSlugOf, appsLink, isAppRule, KNOWN_APPS as KNOWN, MODE_TEXT, type AppMode } from '../../domain/apps';
import { PersonalLimitDialog } from '../limits/LimitDialogs';
import '../limits/limits.css';
import './apps.css';

const STATE_PILL: Record<LimitState, { text: string; tone?: 'ok' | 'warn' | 'danger' | 'info' }> = {
  ok: { text: 'Within budget', tone: 'ok' },
  warning: { text: 'Nearly used up', tone: 'warn' },
  exhausted: { text: 'Time used up', tone: 'danger' },
  outside_hours: { text: 'Outside allowed hours', tone: 'warn' },
  blocked: { text: 'Blocked', tone: 'danger' },
  no_budget: { text: 'No daily budget', tone: 'info' },
};

const fmt = (sec: number) => (sec < 90 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`);

export function Apps() {
  const limits = useData((s) => s.docs.limits);
  const mode = useData((s) => s.settings.appEnforcement);
  const rules = useDayRules();
  const now = useNow(15_000);
  const today = useTodayKey();
  const apps = useEnv((s) => s.apps);
  const status = useEnv((s) => s.appsStatus);
  const usageRows = useEnv((s) => s.appsUsage);
  const policies = useEnv((s) => s.policies);
  const [edit, setEdit] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [gamesOnly, setGamesOnly] = useState(false);
  const native = getBackend().kind === 'native';

  useEffect(() => {
    if (native) void useEnv.getState().refreshApps();
  }, [native]);

  const link = appsLink(native, mode, native && !!status);
  const effective = useMemo(() => combineRules(limits, policies, now).filter((e) => isAppRule(e.platform)), [limits, policies, now]);
  const personalAllowed = policies.every((p) => p.allowPersonalLimits);
  const usedToday = useMemo(() => new Map((status?.usage ?? []).map(([s, sec]) => [s, sec] as const)), [status]);
  const runningNow = useMemo(() => new Set((apps ?? []).filter((a) => a.running).map((a) => a.slug)), [apps]);
  const ruleSlugs = new Set(effective.map((e) => appSlugOf(e.platform)));

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (apps ?? []).filter((a) => (!gamesOnly || a.game) && (!q || a.name.toLowerCase().includes(q) || a.slug.includes(q)));
  }, [apps, query, gamesOnly]);

  const last7 = rangeDays(addDays(today, -6), 7);
  const histApps = useMemo(() => [...new Set(usageRows.map((r) => r[1]))].sort(), [usageRows]);

  const setMode = (m: AppMode) => void attempt(() => useData.getState().updateSettings((s) => ({ ...s, appEnforcement: m })), 'Setting not saved');

  return (
    <div>
      <header className="page-head">
        <div>
          <p className="label">Digital life control</p>
          <h1 className="display">Apps</h1>
          <p>Games and other programs on this computer. Choose how long each may be open, and when. If your class sets a rule for an app, it applies here automatically.</p>
        </div>
        <div className="cluster">
          <Button onClick={() => void useEnv.getState().refreshApps()} disabled={!native}><RefreshCw size={15} aria-hidden /> Refresh list</Button>
          <Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden /> Limit an app</Button>
        </div>
      </header>

      <div className="sec">
        <SectionHead index="01" title="How limits are enforced" />
        <ul className="rows">
          <li className="row">
            {link === 'active' ? <ShieldCheck size={20} aria-hidden style={{ color: 'var(--accent)' }} /> : <ShieldAlert size={20} aria-hidden style={{ color: 'var(--warn)' }} />}
            <div className="row-main">
              <span className="row-title">Apps on this computer</span>
              <span className="row-sub">{APPS_LINK_TEXT[link].note}</span>
            </div>
            <Pill tone={link === 'active' ? 'ok' : link === 'preview' ? undefined : 'warn'}>{APPS_LINK_TEXT[link].pill}</Pill>
          </li>
        </ul>
        <div className="stack" style={{ marginTop: 'var(--s-4)' }}>
          <Segmented<AppMode> label="How limits are enforced" value={mode} onChange={setMode} options={(Object.keys(MODE_TEXT) as AppMode[]).map((m) => ({ value: m, label: MODE_TEXT[m].title }))} />
          <p className="muted">{MODE_TEXT[mode].detail}</p>
          <p className="faint" style={{ fontSize: 'var(--fs-small)' }}>
            Time means how long an app is <b>open</b>, not how long its window is in front. The operating system, terminals, web browsers and FOCUS OS itself can never be limited here; websites are limited in <b>Limits</b> through the browser extension.
          </p>
        </div>
        {status && status.ignored.length > 0 && (
          <Banner tone="info" title="Some rules cannot be enforced">{status.ignored.map(appDisplayName).join(', ')} {status.ignored.length === 1 ? 'is' : 'are'} a protected program, so FOCUS OS ignores {status.ignored.length === 1 ? 'its' : 'their'} rule.</Banner>
        )}
      </div>

      <div className="sec">
        <SectionHead index="02" title="Limits in force" />
        {effective.length === 0 ? (
          <Empty title="No app limits yet." action={<Button variant="primary" onClick={() => setAdding(true)}>Limit your first app</Button>}>Pick a game below, or add one by name, then give it a daily budget or allowed hours. Rules your class publishes appear here too, marked as class rules.</Empty>
        ) : (
          <div role="list">
            {effective.map((e) => {
              const slug = appSlugOf(e.platform);
              const used = usedToday.get(slug) ?? 0;
              const personal = limits.find((l) => l.platform === e.platform);
              const warn = personal?.warnAtPct ?? 80;
              const ev = evaluate(e, { measuredSec: used, selfReportedSec: 0 }, now, rules.timeZone, 'connected', warn);
              const pill = STATE_PILL[ev.state];
              const open = runningNow.has(slug);
              const enforced = link === 'active' && mode !== 'off';
              return (
                <div className="app-row" role="listitem" key={e.platform}>
                  <div>
                    <p className="app-name">{appDisplayName(slug)}</p>
                    <div className="cluster" style={{ marginTop: 6 }}>
                      {e.origins.map((o, i) => <Pill key={i} tone={o.origin === 'class' ? 'info' : undefined}>{o.origin === 'class' ? `Class · ${o.label}` : o.label}</Pill>)}
                      {e.inactivePersonal && <Pill tone="warn" title={e.inactivePersonal}>Your rule: {e.inactivePersonal.toLowerCase()}</Pill>}
                      {open && <Pill tone="info">Open now</Pill>}
                    </div>
                  </div>
                  <div className="lim-detail">
                    {ev.limitMin !== null && <Meter value={ev.usedMin} max={Math.max(1, ev.limitMin)} tone={ev.state === 'exhausted' ? 'danger' : ev.state === 'warning' ? 'warn' : undefined} label={`${appDisplayName(slug)} open ${fmt(used)} of ${ev.limitMin} minutes`} mark={(ev.limitMin * warn) / 100} />}
                    <div className="lim-nums">
                      <span>Open today <b>{fmt(used)}</b></span>
                      {ev.limitMin !== null && <span>Budget <b>{ev.limitMin} min</b></span>}
                      {ev.remainingMin !== null && ev.state !== 'blocked' && <span>Left <b>{Math.round(ev.remainingMin)} min</b></span>}
                    </div>
                    <span className="row-sub">{enforced ? (mode === 'close' ? 'Enforced on this computer: warned, then closed.' : 'Reminders only on this computer; nothing is closed.') : 'Configured, but not enforced on this computer right now.'}</span>
                  </div>
                  <div className="stack" style={{ alignItems: 'flex-end', gap: 8 }}>
                    <Pill tone={pill.tone}>{pill.text}</Pill>
                    <Pill tone={enforced ? 'ok' : 'warn'}>{enforced ? (mode === 'close' ? 'Enforced' : 'Reminders only') : 'Not enforced'}</Pill>
                    <Button size="sm" variant="quiet" aria-label={`${personal ? 'Edit your rule for' : 'Add your own rule for'} ${appDisplayName(slug)}`} onClick={() => setEdit(e.platform)}><Pencil size={13} aria-hidden /> {personal ? 'Edit' : 'Add rule'}</Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="sec">
        <SectionHead index="03" title="Apps on this computer" />
        {!native ? (
          <Empty title="The list needs the desktop app.">In the browser preview FOCUS OS cannot see which programs are installed or running. Install the desktop app, or use “Limit an app” to set a rule by name.</Empty>
        ) : apps === null ? (
          <p className="faint" role="status">Looking at this computer…</p>
        ) : (
          <>
            <div className="app-find">
              <Field label="Find an app"><Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name of a game or program" /></Field>
              <Button variant={gamesOnly ? 'primary' : 'default'} aria-pressed={gamesOnly} onClick={() => setGamesOnly(!gamesOnly)}><Gamepad2 size={15} aria-hidden /> Games only</Button>
              <span className="faint" style={{ fontSize: 'var(--fs-small)', paddingBottom: 10 }}>{shown.length} shown</span>
            </div>
            {shown.length === 0 ? <p className="faint" style={{ padding: 'var(--s-3) 0' }}>Nothing matches. If an app is not listed, open it once and press Refresh list, or add it by name.</p> : (
              <ul className="rows app-list" tabIndex={0} aria-label="Apps found on this computer">
                {shown.map((a) => (
                  <li className="row" key={a.slug}>
                    {a.game ? <Gamepad2 size={18} aria-hidden className="faint" /> : <Monitor size={18} aria-hidden className="faint" />}
                    <span className="row-main"><span className="row-title">{a.name}</span><span className="row-sub">{a.running ? 'Open now' : a.installed ? 'Installed' : ''}{usedToday.get(a.slug) ? ` · open ${fmt(usedToday.get(a.slug)!)} today` : ''}</span></span>
                    {ruleSlugs.has(a.slug) && <Pill tone="info">Has a rule</Pill>}
                    <Button size="sm" aria-label={`${ruleSlugs.has(a.slug) ? 'Edit limit for' : 'Set a limit for'} ${a.name}`} onClick={() => setEdit(appRuleId(a.slug))}>{ruleSlugs.has(a.slug) ? 'Edit' : 'Set limit'}</Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="sec">
        <SectionHead index="04" title="Last seven days" />
        {histApps.length === 0 ? <p className="faint" style={{ padding: 'var(--s-3) 0' }}>{native ? 'No app time recorded yet. Time is only recorded for apps that have a rule.' : 'App time is recorded by the desktop app.'}</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="hist">
              <caption className="sr-only">Minutes each limited app was open, per day.</caption>
              <thead><tr><th scope="col">App</th>{last7.map((d) => <th scope="col" key={d}>{d.slice(5)}</th>)}</tr></thead>
              <tbody>
                {histApps.map((slug) => (
                  <tr key={slug}>
                    <th scope="row" style={{ color: 'var(--text)', fontFamily: 'var(--font-ui)', letterSpacing: 0, textTransform: 'none', fontSize: 'var(--fs-small)' }}>{appDisplayName(slug)}</th>
                    {last7.map((d) => {
                      const sec = usageRows.filter((r) => r[0] === d && r[1] === slug).reduce((a, r) => a + r[2], 0);
                      return <td className="n" key={d}>{sec ? Math.round(sec / 60) : <span className="faint">–</span>}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="faint" style={{ fontSize: 'var(--fs-small)', marginTop: 8 }}>Minutes the app was open, measured on this computer. Not shared with anyone, including your class.</p>
          </div>
        )}
      </div>

      <PersonalLimitDialog open={edit !== undefined} platformId={edit ?? null} onClose={() => setEdit(undefined)} personalAllowed={personalAllowed} blockedByClass={!!effective.find((e) => e.platform === edit)?.blocked} />
      <AddAppDialog open={adding} onClose={() => setAdding(false)} onPick={(slug) => { setAdding(false); setEdit(appRuleId(slug)); }} />
    </div>
  );
}

function AddAppDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (slug: string) => void }) {
  return open ? <AddAppForm onClose={onClose} onPick={onPick} /> : null;
}

function AddAppForm({ onClose, onPick }: { onClose: () => void; onPick: (slug: string) => void }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const slug = appSlug(name);
  const go = () => {
    if (!slug) return setErr('Type the name of the app or game.');
    onPick(slug);
  };
  return (
    <Dialog open onClose={onClose} title="Limit an app" description="Type the app’s name the way it appears on this computer, for example Roblox or Minecraft Launcher. Pick a game from the list below to be sure of the name." footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go}>Continue</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <Field label="App name" error={err} hint={slug ? `FOCUS OS will look for a program called “${slug}”.` : undefined}>
          <Input value={name} onChange={(e) => { setName(e.target.value); setErr(null); }} autoFocus maxLength={56} list="known-apps" />
        </Field>
        <datalist id="known-apps">{KNOWN.map((k) => <option key={k.slug} value={k.name} />)}</datalist>
      </form>
    </Dialog>
  );
}
