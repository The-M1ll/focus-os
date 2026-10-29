import { lazy, Suspense, useEffect, useRef } from 'react';
import { MotionConfig, motion } from 'motion/react';
import { Search, Settings as SettingsIcon, AlertTriangle } from 'lucide-react';
import { useData } from '../data/store';
import { useTimer } from '../state/timer';
import { useEnv } from '../state/env';
import { useDayRules } from '../state/selectors';
import { NAV, useUI } from './ui-state';
import { Banner, Button, IconButton, Kbd, Toasts, toast } from '../design/ui';
import { Ambient } from '../design/Ambient';
import { Onboarding } from '../features/onboarding/Onboarding';
import { Palette } from './Palette';
import { Shortcuts } from './Shortcuts';
import { Today } from '../features/today/Today';
import { getBackend } from '../data/backend';
import { getClassApi } from '../data/classApi';
import { dayKey, addDays } from '../domain/time';
import { allPlatforms, combineRules, toBridgeRules } from '../domain/limits';
import { toAppsPolicy } from '../domain/apps';
import { isQuietHours } from '../domain/wellness';
import { useRemindersLoop } from './useReminders';

const Library = lazy(() => import('../features/library/Library').then((m) => ({ default: m.Library })));
const Review = lazy(() => import('../features/review/Review').then((m) => ({ default: m.Review })));
const Plan = lazy(() => import('../features/plan/Plan').then((m) => ({ default: m.Plan })));
const Limits = lazy(() => import('../features/limits/Limits').then((m) => ({ default: m.Limits })));
const Apps = lazy(() => import('../features/apps/Apps').then((m) => ({ default: m.Apps })));
const ClassPage = lazy(() => import('../features/classroom/ClassPage').then((m) => ({ default: m.ClassPage })));
const SettingsPage = lazy(() => import('../features/settings/Settings').then((m) => ({ default: m.SettingsPage })));

function SaveStatus() {
  const save = useData((s) => s.save);
  const retry = () => void useData.getState().load();
  if (save.kind === 'error')
    return (
      <span className="save-status" data-kind="error" role="alert">
        <AlertTriangle size={12} aria-hidden /> <span className="txt">Not saved</span> <button className="btn btn-sm btn-quiet" onClick={retry}>Reload</button>
      </span>
    );
  return (
    <span className="save-status" role="status" aria-live="polite">
      {save.kind === 'saving' && (<><i className="dot" /> <span className="txt">Saving…</span></>)}
      {save.kind === 'saved' && (<><i className="dot" style={{ color: 'var(--accent)' }} /> <span className="txt">Saved</span></>)}
    </span>
  );
}

export function App() {
  const ready = useData((s) => s.ready);
  const loadError = useData((s) => s.loadError);
  const settings = useData((s) => s.settings);
  const issues = useData((s) => s.issues);
  const route = useUI((s) => s.route);
  const go = useUI((s) => s.go);
  const timerStatus = useTimer((s) => s.timer?.status);
  const timerKind = useTimer((s) => s.timer?.kind);
  const rules = useDayRules();

  // ---- boot ----
  useEffect(() => {
    void useData.getState().load().then(() => {
      useTimer.getState().init();
      void useEnv.getState().refreshClasses();
    });
  }, []);

  // ---- theme & motion preferences ----
  useEffect(() => {
    const root = document.documentElement;
    const resolved = settings.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme;
    root.dataset.theme = resolved;
    root.dataset.motion = settings.motion;
  }, [settings.theme, settings.motion]);

  // ---- timer heartbeat ----
  useEffect(() => {
    if (timerStatus !== 'running') return;
    const id = setInterval(() => useTimer.getState().tick(), 1000);
    const onVis = () => useTimer.getState().tick();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [timerStatus]);

  // ---- completion notification (once per finish) ----
  const notifiedFor = useRef<string | null>(null);
  useEffect(() => {
    const t = useTimer.getState().timer;
    if (timerStatus !== 'finished' || !t || notifiedFor.current === t.id) return;
    notifiedFor.current = t.id;
    const s = useData.getState().settings;
    const text = timerKind === 'break' ? 'Break over — ready when you are.' : 'Focus session complete. Nicely done.';
    toast.ok(text);
    if (s.wellness.delivery === 'system' && !isQuietHours(Date.now(), rules.timeZone, s.wellness.quiet)) {
      void getBackend().notify('FOCUS OS', text).then((r) => { if (!r.delivered) toast.warn(`System notification not shown: ${r.reason ?? 'unknown reason'}`); });
    }
  }, [timerStatus, timerKind, rules.timeZone]);

  // ---- environment: classes, usage, bridge ----
  useEffect(() => {
    if (!ready) return;
    const refresh = () => {
      const today = dayKey(Date.now(), rules);
      void useEnv.getState().refreshUsage(addDays(today, -13), today);
      if (getBackend().kind === 'native') void useEnv.getState().refreshAppsStatus(addDays(today, -6), today);
    };
    refresh();
    const id = setInterval(refresh, 15_000);
    let un = () => {};
    void getClassApi().onSync((cid, st) => {
      useEnv.getState().setSync(cid, st);
      void useEnv.getState().refreshClasses();
    }).then((f) => { un = f; });
    return () => { clearInterval(id); un(); };
  }, [ready, rules]);

  const limits = useData((s) => s.docs.limits);
  const platforms = useData((s) => s.docs.platforms);
  const manualUsage = useData((s) => s.docs.manual_usage);
  const policies = useEnv((s) => s.policies);
  const bridgeUp = useEnv((s) => s.bridge?.listening ?? false);
  useEffect(() => {
    if (!ready || !bridgeUp) return;
    const now = Date.now();
    const eff = combineRules(limits, policies, now);
    const revision = policies.reduce((a, p) => a + p.revision, 0) + limits.length;
    const day = dayKey(now, rules);
    const selfReported: Record<string, number> = {};
    for (const m of manualUsage) if (m.day === day) selfReported[m.platform] = (selfReported[m.platform] ?? 0) + m.minutes;
    void getBackend().bridgeSetRules(toBridgeRules(eff, allPlatforms(platforms), rules, now, revision + manualUsage.length, selfReported)).catch(() => undefined);
  }, [ready, bridgeUp, limits, platforms, policies, rules, manualUsage]);

  // ---- desktop apps: push the effective rules to the native monitor, and show its warnings ----
  const appMode = settings.appEnforcement;
  useEffect(() => {
    if (!ready || getBackend().kind !== 'native') return;
    const push = () => {
      const now = Date.now();
      const eff = combineRules(limits, policies, now);
      void getBackend().appsPush(toAppsPolicy(eff, rules, now, appMode)).catch(() => undefined);
    };
    push();
    const id = setInterval(push, 30_000);
    return () => clearInterval(id);
  }, [ready, limits, policies, rules, appMode]);

  useEffect(() => {
    if (!ready) return;
    let un = () => {};
    let gone = false;
    void getBackend().onAppsNotice((n) => {
      if (n.kind === 'closing') toast.warn(`${n.label} will close in ${n.seconds_left} s. ${n.why} Save your work.`);
      else if (n.kind === 'low_time') toast.warn(`${n.label}: about ${Math.ceil(n.seconds_left / 60)} min left. Save your work.`);
      else if (n.kind === 'closed') toast.warn(`${n.label} was closed. ${n.why}`);
      else toast.warn(`${n.label}: time is up. ${n.why} (Reminder only: nothing was closed.)`);
    }).then((f) => { if (gone) f(); else un = f; });
    return () => { gone = true; un(); };
  }, [ready]);

  useRemindersLoop(ready);

  // ---- global shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useUI.getState().setPalette(!useUI.getState().paletteOpen);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
      if (e.key === '?') { useUI.getState().setShortcuts(true); return; }
      const n = NAV.find((x) => x.key === e.key);
      if (n && !(n.route === 'review' && useUI.getState().reviewMode)) { go(n.route); return; }
      if (e.key === ' ' && useUI.getState().route === 'today' && (t?.tagName ?? '') !== 'BUTTON') {
        e.preventDefault();
        const st = useTimer.getState();
        if (!st.timer) st.start({ kind: 'focus', plannedMs: useData.getState().settings.focus.focusMin * 60_000 });
        else if (st.timer.status === 'running') st.pause();
        else if (st.timer.status === 'paused') st.resume();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  // save the timer immediately if the window is closing or hidden
  useEffect(() => {
    const flush = () => useTimer.getState().tick();
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  if (loadError) {
    return (
      <main className="page" style={{ maxWidth: 640 }}>
        <h1 className="display h2">Your data could not be opened.</h1>
        <p className="muted" style={{ margin: 'var(--s-3) 0 var(--s-5)' }}>{loadError}</p>
        <p className="muted">Nothing was changed or deleted. You can retry, or restore a backup from Settings after the app starts.</p>
        <Button variant="primary" style={{ marginTop: 'var(--s-4)' }} onClick={() => void useData.getState().load()}>Try again</Button>
      </main>
    );
  }
  if (!ready) return <div role="status" className="sr-only">Loading your workspace</div>;
  if (!settings.onboarded) return (<MotionConfig reducedMotion={settings.motion === 'reduce' ? 'always' : settings.motion === 'full' ? 'never' : 'user'}><Onboarding /><Toasts /></MotionConfig>);

  const Screen = { today: Today, library: Library, review: Review, plan: Plan, limits: Limits, apps: Apps, class: ClassPage, settings: SettingsPage }[route];

  return (
    <MotionConfig reducedMotion={settings.motion === 'reduce' ? 'always' : settings.motion === 'full' ? 'never' : 'user'}>
      {settings.ambient && <Ambient />}
      <div className="app">
        <a className="skip-link" href="#main">Skip to content</a>
        <header className="masthead">
          <a className="wordmark" href="#/today" onClick={() => go('today')} aria-label="FOCUS OS home">
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="9.5" fill="none" stroke="var(--accent)" strokeWidth="1.6" /><circle cx="12" cy="2.5" r="2" fill="var(--accent)" /></svg>
            FOCUS <small>OS</small>
          </a>
          <nav className="nav" aria-label="Primary">
            {NAV.map((n) => (
              <a key={n.route} href={`#/${n.route}`} aria-current={route === n.route ? 'page' : undefined} onClick={(e) => { e.preventDefault(); go(n.route); }}>
                <span className="nav-index">{n.key}</span>
                {n.label}
                {route === n.route && <motion.span layoutId="nav-underline" className="nav-underline" transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
              </a>
            ))}
          </nav>
          <div className="masthead-tools">
            <SaveStatus />
            <Button size="sm" variant="quiet" onClick={() => useUI.getState().setPalette(true)} aria-label="Open command palette"><Search size={15} aria-hidden /> <Kbd>{/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'} K</Kbd></Button>
            <IconButton label="Settings" aria-current={route === 'settings' ? 'page' : undefined} onClick={() => go('settings')}><SettingsIcon size={18} aria-hidden /></IconButton>
          </div>
        </header>
        <main className="page" id="main" tabIndex={-1}>
          {getBackend().kind === 'browser' && (
            <Banner tone="info" title="Browser preview.">Your data is saved in this browser only. The desktop app stores everything in a local SQLite database and adds classroom and extension features.</Banner>
          )}
          {issues.length > 0 && (
            <Banner title={`${issues.length} saved item${issues.length === 1 ? '' : 's'} could not be read.`} actions={<Button size="sm" variant="quiet" onClick={() => go('settings')}>Details</Button>}>
              They were left untouched in storage so nothing is lost.
            </Banner>
          )}
          <Suspense fallback={<div role="status" className="faint">Loading…</div>}>
            <motion.div key={route} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
              <Screen />
            </motion.div>
          </Suspense>
        </main>
        <Palette />
        <Shortcuts />
        <Toasts />
      </div>
    </MotionConfig>
  );
}

