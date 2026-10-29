import { useEffect, useMemo, useState } from 'react';
import { Archive, Download, RotateCcw, Upload, Trash2, BellRing } from 'lucide-react';
import { useData } from '../../data/store';
import { COLLECTIONS, type CollectionName, type Settings } from '../../domain/schemas';
import { getBackend, type BackupInfo } from '../../data/backend';
import { attempt, Banner, Button, Dialog, Field, Input, Pill, SectionHead, Segmented, Select, Switch, toast } from '../../design/ui';
import { SYSTEM_ZONE, isValidZone } from '../../domain/time';

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

const sizeText = (b: number) => (b > 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function SettingsPage() {
  const s = useData((x) => x.settings);
  const issues = useData((x) => x.issues);
  const update = (fn: (s: Settings) => Settings) => void attempt(() => useData.getState().updateSettings(fn), 'Setting not saved');
  const tzList = useMemo(() => { const z = zones(); return z.includes(s.timeZone) ? z : [s.timeZone, ...z]; }, [s.timeZone]);
  const be = getBackend();

  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [restoreName, setRestoreName] = useState<string | null>(null);
  const [wipe, setWipe] = useState(false);
  const [wipeText, setWipeText] = useState('');
  const [importReplace, setImportReplace] = useState<boolean | null>(null);

  const loadBackups = () => void be.listBackups().then(setBackups).catch(() => setBackups([]));
  useEffect(loadBackups, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key: string, fn: () => Promise<void>) => { setBusy(key); await fn(); setBusy(null); };

  const doBackup = () => run('backup', async () => {
    const r = await attempt(() => be.backupNow(), 'Backup failed');
    if (r.ok) { toast.ok(`Backup saved and verified (${sizeText(r.value.bytes)}).`); loadBackups(); }
  });
  const doExport = () => run('export', async () => {
    const r = await attempt(() => be.exportFile(), 'Export failed');
    if (r.ok) toast.ok(r.value ? `Exported to ${r.value}.` : 'Export cancelled.');
  });
  const doImport = (replace: boolean) => run('import', async () => {
    const r = await attempt(() => be.importFile(replace), 'Import failed — nothing was changed');
    if (r.ok && r.value !== null) { toast.ok(`Imported ${r.value} items.`); await useData.getState().reloadAfterRestore(); }
    setImportReplace(null);
  });
  const doRestore = (name: string) => run('restore', async () => {
    const r = await attempt(() => be.restoreBackup(name), 'Restore failed — nothing was changed');
    if (r.ok) { toast.ok(`Restored ${r.value} items. A safety copy of your previous data was saved first.`); await useData.getState().reloadAfterRestore(); loadBackups(); }
    setRestoreName(null);
  });
  const doWipe = () => run('wipe', async () => {
    const snap = await attempt(() => be.backupNow(), 'Could not make a safety backup, so nothing was deleted');
    if (!snap.ok) return;
    const ops: { del: { c: CollectionName; id: string } }[] = [];
    const d = useData.getState().docs;
    for (const c of Object.keys(COLLECTIONS) as CollectionName[]) for (const x of d[c] as { id: string }[]) ops.push({ del: { c, id: x.id } });
    for (let i = 0; i < ops.length; i += 300) {
      const r = await attempt(() => useData.getState().batch(ops.slice(i, i + 300)), 'Deleting failed part-way');
      if (!r.ok) return;
    }
    setWipe(false); setWipeText('');
    toast.ok('Your study data was deleted. A safety backup remains until you delete it.');
  });

  const testNotify = async () => {
    const r = await attempt(() => be.notify('FOCUS OS', 'This is a test notification.'), 'Could not send');
    if (r.ok) (r.value.delivered ? toast.ok : toast.warn)(r.value.delivered ? 'Sent. If you saw nothing, check your system’s notification settings.' : `Not shown: ${r.value.reason ?? 'the system refused'}.`);
  };

  return (
    <div>
      <header className="page-head"><div><p className="label">Preferences · data · privacy</p><h1 className="display">Settings</h1></div></header>

      <div className="grid-even">
        <div>
          <div className="sec">
            <SectionHead index="01" title="General" />
            <div className="stack">
              <Field label="Your name" hint="Used only for the greeting."><Input value={s.displayName} maxLength={60} onChange={(e) => update((x) => ({ ...x, displayName: e.target.value }))} /></Field>
              <div className="field"><span className="field-label">Theme</span><Segmented label="Theme" value={s.theme} onChange={(v) => update((x) => ({ ...x, theme: v }))} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'Match system' }]} /></div>
              <div className="field"><span className="field-label">Animation</span><Segmented label="Animation" value={s.motion} onChange={(v) => update((x) => ({ ...x, motion: v }))} options={[{ value: 'system', label: 'Match system' }, { value: 'reduce', label: 'Reduced' }, { value: 'full', label: 'Full' }]} /></div>
              <Field label="Time zone" hint="Decides when “today” starts for limits, plans and reviews.">
                <Select value={s.timeZone} onChange={(e) => isValidZone(e.target.value) && update((x) => ({ ...x, timeZone: e.target.value }))}>{tzList.map((z) => <option key={z} value={z}>{z}</option>)}</Select>
              </Field>
              <Button size="sm" variant="quiet" onClick={() => update((x) => ({ ...x, timeZone: SYSTEM_ZONE() }))}>Use this computer’s time zone ({SYSTEM_ZONE()})</Button>
              <Field label="A new day starts at" hint="Late-night studying counts toward the day you started. 04:00 keeps a 1 a.m. session in the same day.">
                <Select value={s.resetHour} onChange={(e) => update((x) => ({ ...x, resetHour: Number(e.target.value) }))}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}</Select>
              </Field>
            </div>
          </div>

          <div className="sec">
            <SectionHead index="02" title="Focus & planning" />
            <div className="stack">
              <div className="cluster">
                <Field label="Focus (min)"><Input type="number" min={1} max={180} value={s.focus.focusMin} onChange={(e) => update((x) => ({ ...x, focus: { ...x.focus, focusMin: Math.max(1, Math.min(180, Number(e.target.value) || 25)) } }))} style={{ width: 100 }} /></Field>
                <Field label="Short break"><Input type="number" min={1} max={60} value={s.focus.shortBreakMin} onChange={(e) => update((x) => ({ ...x, focus: { ...x.focus, shortBreakMin: Math.max(1, Math.min(60, Number(e.target.value) || 5)) } }))} style={{ width: 100 }} /></Field>
                <Field label="Long break"><Input type="number" min={1} max={90} value={s.focus.longBreakMin} onChange={(e) => update((x) => ({ ...x, focus: { ...x.focus, longBreakMin: Math.max(1, Math.min(90, Number(e.target.value) || 15)) } }))} style={{ width: 100 }} /></Field>
                <Field label="Long break every"><Input type="number" min={2} max={8} value={s.focus.cyclesBeforeLong} onChange={(e) => update((x) => ({ ...x, focus: { ...x.focus, cyclesBeforeLong: Math.max(2, Math.min(8, Number(e.target.value) || 4)) } }))} style={{ width: 100 }} /></Field>
              </div>
              <Field label="Study time I can realistically give per day (min)" hint="Plan warns when a day is planned beyond this."><Input type="number" min={15} max={960} step={15} value={s.capacityMin} onChange={(e) => update((x) => ({ ...x, capacityMin: Math.max(15, Math.min(960, Number(e.target.value) || 150)) }))} style={{ width: 120 }} /></Field>
              <div className="cluster">
                <Field label="New cards per day"><Input type="number" min={0} max={100} value={s.newCardsPerDay} onChange={(e) => update((x) => ({ ...x, newCardsPerDay: Math.max(0, Math.min(100, Number(e.target.value) || 0)) }))} style={{ width: 120 }} /></Field>
                <Field label="Most reviews per day"><Input type="number" min={5} max={500} value={s.maxReviewsPerDay} onChange={(e) => update((x) => ({ ...x, maxReviewsPerDay: Math.max(5, Math.min(500, Number(e.target.value) || 60)) }))} style={{ width: 120 }} /></Field>
              </div>
            </div>
          </div>

          <div className="sec">
            <SectionHead index="03" title="Healthy study habits" />
            <div className="stack">
              <Switch label="Eye-rest reminder" checked={s.wellness.eyeRest.enabled} onChange={(v) => update((x) => ({ ...x, wellness: { ...x.wellness, eyeRest: { ...x.wellness.eyeRest, enabled: v } } }))} description="A gentle nudge during focus sessions." />
              {s.wellness.eyeRest.enabled && <Field label="Every (min of focus)"><Input type="number" min={10} max={120} value={s.wellness.eyeRest.everyMin} onChange={(e) => update((x) => ({ ...x, wellness: { ...x.wellness, eyeRest: { ...x.wellness.eyeRest, everyMin: Math.max(10, Math.min(120, Number(e.target.value) || 20)) } } }))} style={{ width: 100 }} /></Field>}
              <Switch label="Stretch / movement reminder" checked={s.wellness.movement.enabled} onChange={(v) => update((x) => ({ ...x, wellness: { ...x.wellness, movement: { ...x.wellness.movement, enabled: v } } }))} />
              {s.wellness.movement.enabled && <Field label="Every (min of focus)"><Input type="number" min={20} max={240} value={s.wellness.movement.everyMin} onChange={(e) => update((x) => ({ ...x, wellness: { ...x.wellness, movement: { ...x.wellness.movement, everyMin: Math.max(20, Math.min(240, Number(e.target.value) || 50)) } } }))} style={{ width: 100 }} /></Field>}
              <Switch label="Quiet hours" checked={s.wellness.quiet.enabled} onChange={(v) => update((x) => ({ ...x, wellness: { ...x.wellness, quiet: { ...x.wellness.quiet, enabled: v } } }))} description="No reminders or notifications during these hours." />
              {s.wellness.quiet.enabled && <div className="cluster"><Field label="From"><Input type="time" value={s.wellness.quiet.start} onChange={(e) => e.target.value && update((x) => ({ ...x, wellness: { ...x.wellness, quiet: { ...x.wellness.quiet, start: e.target.value } } }))} /></Field><Field label="Until"><Input type="time" value={s.wellness.quiet.end} onChange={(e) => e.target.value && update((x) => ({ ...x, wellness: { ...x.wellness, quiet: { ...x.wellness.quiet, end: e.target.value } } }))} /></Field></div>}
              <div className="field"><span className="field-label">How reminders reach me</span><Segmented label="Delivery" value={s.wellness.delivery} onChange={(v) => update((x) => ({ ...x, wellness: { ...x.wellness, delivery: v } }))} options={[{ value: 'in-app', label: 'In the app' }, { value: 'system', label: 'System notification' }, { value: 'off', label: 'Off' }]} /></div>
              {s.wellness.delivery === 'system' && <Button size="sm" onClick={() => void testNotify()}><BellRing size={14} aria-hidden /> Send a test notification</Button>}
              <p className="faint" style={{ fontSize: 'var(--fs-small)' }}>These are general habits tips, not medical advice. Nothing is monitored — no camera, microphone or keystrokes.</p>
            </div>
          </div>
        </div>

        <div>
          <div className="sec">
            <SectionHead index="04" title="Your data" />
            <p className="muted" style={{ marginBottom: 'var(--s-3)' }}>Storage: <Pill tone={be.kind === 'native' ? 'ok' : 'warn'}>{be.kind === 'native' ? 'Local SQLite database' : 'Browser preview storage'}</Pill></p>
            <div className="cluster">
              <Button busy={busy === 'backup'} onClick={() => void doBackup()}><Archive size={15} aria-hidden /> Back up now</Button>
              <Button busy={busy === 'export'} onClick={() => void doExport()}><Download size={15} aria-hidden /> Export everything</Button>
              <Button busy={busy === 'import'} onClick={() => setImportReplace(false)}><Upload size={15} aria-hidden /> Import</Button>
            </div>
            <p className="faint" style={{ fontSize: 'var(--fs-small)', margin: 'var(--s-3) 0' }}>Exports are plain JSON you own. Backups are verified after writing and the 20 newest are kept. Class keys and membership are never included.</p>
            {backups.length > 0 && (
              <ul className="rows">
                {backups.map((b) => <li className="row" key={b.name}><span className="row-main"><span className="row-title mono" style={{ fontSize: 'var(--fs-small)' }}>{b.name.replace(/^focus-/, '')}</span><span className="row-sub">{new Date(b.modified_ms).toLocaleString()} · {sizeText(b.bytes)}</span></span><Button size="sm" variant="quiet" onClick={() => setRestoreName(b.name)}><RotateCcw size={13} aria-hidden /> Restore</Button></li>)}
              </ul>
            )}
            {issues.length > 0 && (
              <Banner title={`${issues.length} saved item${issues.length === 1 ? '' : 's'} can’t be read.`}>
                They were left in storage untouched (they may come from a newer version, or be damaged). Restoring a backup or exporting will not delete them.
                <ul className="privacy-list">{issues.slice(0, 8).map((i) => <li key={`${i.collection}/${i.id}`}><span className="mono">{i.collection}/{i.id}</span> — {i.problem}</li>)}</ul>
              </Banner>
            )}
            <div style={{ marginTop: 'var(--s-5)' }}><Button variant="danger" onClick={() => setWipe(true)}><Trash2 size={15} aria-hidden /> Delete all my study data…</Button></div>
          </div>

          <div className="sec">
            <SectionHead index="05" title="Privacy" />
            <ul className="privacy-list">
              <li>Everything you write lives on this computer. There is no account, no cloud sync and <b>no analytics or telemetry</b>.</li>
              <li>Notes, flashcards, tasks, sessions and usage are never sent anywhere — not to a class, a teacher or family.</li>
              <li>If you join a class, the administrator’s computer sees your chosen name, whether you’re online and which policy revision you have. That travels only over your local network.</li>
              <li>The browser extension talks to this app on <span className="mono">127.0.0.1</span> only, with a secret token.</li>
              <li>FOCUS OS never records the screen, keystrokes, camera or microphone, and never scans your files.</li>
            </ul>
          </div>

          <div className="sec">
            <SectionHead index="06" title="What this version can’t do" />
            <ul className="privacy-list">
              <li>Block or measure <b>apps</b> outside the browser. Websites need the browser extension.</li>
              <li>Stop a student who controls their own computer from removing the extension or this app. Class rules are coordination, not a lock.</li>
              <li>Deliver class updates while the host computer is off or on another network.</li>
              <li>Encrypt classroom traffic: it is signed and replay-protected, but visible to others on the same network. See Security notes in the project docs.</li>
              <li>Windows and macOS builds are unverified in this release; Linux is the tested platform.</li>
            </ul>
          </div>
        </div>
      </div>

      <Dialog open={restoreName !== null} onClose={() => setRestoreName(null)} title="Restore this backup?" footer={<><Button variant="quiet" onClick={() => setRestoreName(null)}>Cancel</Button><Button variant="primary" busy={busy === 'restore'} onClick={() => restoreName && void doRestore(restoreName)}>Restore</Button></>}>
        <p>Your current data will be replaced with this backup. A safety copy of what you have now is saved first, so you can undo this.</p>
      </Dialog>
      <Dialog open={importReplace !== null} onClose={() => setImportReplace(null)} title="Import data" footer={<><Button variant="quiet" onClick={() => setImportReplace(null)}>Cancel</Button><Button variant="primary" busy={busy === 'import'} onClick={() => void doImport(importReplace ?? false)}>Choose file…</Button></>}>
        <div className="stack"><p>Choose a FOCUS OS export. The file is fully checked before anything changes; if it’s damaged, nothing is touched.</p><Segmented label="Import mode" value={importReplace ? 'replace' : 'merge'} onChange={(v) => setImportReplace(v === 'replace')} options={[{ value: 'merge', label: 'Add to what I have' }, { value: 'replace', label: 'Replace everything' }]} /></div>
      </Dialog>
      <Dialog open={wipe} onClose={() => { setWipe(false); setWipeText(''); }} title="Delete all study data?" footer={<><Button variant="quiet" onClick={() => { setWipe(false); setWipeText(''); }}>Keep my data</Button><Button variant="danger" disabled={wipeText !== 'DELETE'} busy={busy === 'wipe'} onClick={() => void doWipe()}>Delete everything</Button></>}>
        <div className="stack"><Banner tone="danger">This removes all subjects, notes, cards, quizzes, tasks, exams, sessions and settings. A backup is made first. Classes you joined or run are separate and are not affected.</Banner><Field label="Type DELETE to confirm"><Input value={wipeText} onChange={(e) => setWipeText(e.target.value)} autoComplete="off" /></Field></div>
      </Dialog>
    </div>
  );
}
