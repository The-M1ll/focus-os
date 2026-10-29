import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { attempt, Banner, Button, Dialog, Field, Input, Pill, SectionHead, toast } from '../../design/ui';
import { getClassApi, type ClassOverview, type StoredPolicy } from '../../data/classApi';
import { useEnv } from '../../state/env';
import { useNow } from '../../state/selectors';
import { describeSync, ago } from './syncText';
import { allPlatforms } from '../../domain/limits';
import { useData } from '../../data/store';

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function MemberPanel({ overview }: { overview: ClassOverview }) {
  const m = overview.membership;
  const api = getClassApi();
  const now = useNow(5_000);
  const status = useEnv((s) => s.syncByClass[m.class_id]) ?? overview.sync;
  const platforms = allPlatforms(useData((s) => s.docs.platforms));
  const [policy, setPolicy] = useState<StoredPolicy | null>(null);
  const [addrOpen, setAddrOpen] = useState(false);
  const [addr, setAddr] = useState(m.host_addrs[0] ?? '');
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const view = describeSync(status, now);

  useEffect(() => { void api.policy(m.class_id).then(setPolicy).catch(() => setPolicy(null)); }, [api, m.class_id, status?.last_revision]);

  const syncNow = async () => {
    setBusy(true);
    const r = await attempt(() => api.syncNow(m.class_id), 'Could not sync');
    setBusy(false);
    if (r.ok) { toast.ok(r.value.startsWith('Applied') ? 'Received a newer policy.' : 'Already up to date.'); void useEnv.getState().refreshClasses(); }
  };
  const nameOf = (id: string) => platforms.find((p) => p.id === id)?.name ?? id;
  const p = policy?.envelope.payload;

  return (
    <div>
      <div className="sec">
        <SectionHead index="01" title="Connection" />
        <div className="status-line"><Pill tone={view.tone}>{view.label}</Pill><span className="muted">{view.detail}</span></div>
        <p className="faint" style={{ fontSize: 'var(--fs-small)', marginTop: 6 }}>Host address on file: <span className="mono">{m.host_addrs.join(', ') || '—'}</span></p>
        <div className="cluster" style={{ marginTop: 'var(--s-3)' }}>
          <Button size="sm" busy={busy} onClick={() => void syncNow()} disabled={m.status === 'removed'}><RefreshCw size={13} aria-hidden /> Sync now</Button>
          <Button size="sm" variant="quiet" onClick={() => { setAddr(m.host_addrs[0] ?? ''); setAddrOpen(true); }}>Change host address</Button>
          <Button size="sm" variant="quiet" onClick={() => setLeaveOpen(true)}>Leave class</Button>
        </div>
        {view.tone === 'warn' && <Banner tone="info" title="The host may be off or on another network.">Class policy changes can only arrive while the administrator’s computer is on and on the same network. Until then nothing about your own studying is affected.</Banner>}
      </div>

      <div className="sec">
        <SectionHead index="02" title="Rules from this class" />
        {!p ? <p className="faint" style={{ padding: 'var(--s-3) 0' }}>No policy has been received yet.</p> : (
          <>
            <p className="muted" style={{ marginBottom: 'var(--s-2)' }}>Revision {policy!.envelope.revision}, received {ago(policy!.received_at, now)}. Verified against the class key you trusted when you joined.</p>
            {p.limits.length === 0 ? <p className="faint">This class has no platform rules.</p> : (
              <ul className="rows">
                {p.limits.map((l) => (
                  <li className="row" key={l.platform}>
                    <span className="row-main"><span className="row-title">{nameOf(l.platform)}</span><span className="row-sub">{l.blocked ? 'Blocked' : [l.daily_minutes !== null ? `${l.daily_minutes} min per day` : null, l.allowed_windows[0] ? `only ${hhmm(l.allowed_windows[0].start_min)}–${hhmm(l.allowed_windows[0].end_min)}` : null].filter(Boolean).join(', ') || 'No restriction'}</span></span>
                  </li>
                ))}
              </ul>
            )}
            {p.study_goals.length > 0 && <><p className="label" style={{ margin: 'var(--s-4) 0 var(--s-1)' }}>Class study goals</p><ul className="rows">{p.study_goals.map((g) => <li className="row" key={g.id}><span className="row-main"><span className="row-title">{g.title}</span></span><span className="label">{Math.round((g.target_minutes_per_week / 60) * 10) / 10} h / week</span></li>)}</ul></>}
            <p className="muted" style={{ marginTop: 'var(--s-3)' }}>{p.allow_personal_limits ? 'You may add stricter limits of your own on the Limits page.' : 'This class does not allow personal limits.'}</p>
          </>
        )}
        <Banner tone="info" title="Enforcement depends on your browser extension.">Rules are shown and tracked everywhere, but only websites in a browser with the FOCUS OS extension can be measured or blocked. See Limits for what is enforced right now.</Banner>
      </div>

      <div className="sec">
        <SectionHead index="03" title="What the administrator can see" />
        <ul className="privacy-list"><li>Your name and that this device is online or offline</li><li>The policy revision your device has confirmed</li></ul>
        <p className="muted" style={{ marginTop: 6 }}>Your notes, flashcards, tasks, focus sessions and usage never leave this computer.</p>
      </div>

      <Dialog open={addrOpen} onClose={() => setAddrOpen(false)} title="Change host address" description="Use this if the administrator’s computer got a new address or moved." footer={<><Button variant="quiet" onClick={() => setAddrOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => void attempt(() => api.setHostAddr(m.class_id, addr), 'Not saved').then((r) => { if (r.ok) { toast.ok('Address updated. Reconnecting…'); setAddrOpen(false); void useEnv.getState().refreshClasses(); } })}>Save</Button></>}>
        <Field label="Host address" hint="ip:port, e.g. 192.168.1.20:47800"><Input value={addr} onChange={(e) => setAddr(e.target.value)} autoFocus /></Field>
      </Dialog>
      <Dialog open={leaveOpen} onClose={() => setLeaveOpen(false)} title="Leave this class?" footer={<><Button variant="quiet" onClick={() => setLeaveOpen(false)}>Stay</Button><Button variant="danger" onClick={() => void attempt(() => api.leave(m.class_id), 'Could not leave').then((r) => { if (r.ok) { toast.ok('You left the class. Its rules no longer apply.'); setLeaveOpen(false); void useEnv.getState().refreshClasses(); } })}>Leave class</Button></>}>
        <p>The class’s rules stop applying on this computer. You’ll need a new invite to rejoin.</p>
      </Dialog>
    </div>
  );
}
