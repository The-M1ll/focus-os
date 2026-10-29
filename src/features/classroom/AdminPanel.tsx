import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, Download, KeyRound, Play, RefreshCw, Square, UserMinus, ArrowRightLeft } from 'lucide-react';
import { attempt, Banner, Button, Dialog, Empty, Field, Input, Pill, SectionHead, Select, toast } from '../../design/ui';
import { getClassApi, type AuditEntry, type ClassOverview, type Invite, type MemberInfo, type StoredPolicy } from '../../data/classApi';
import { useEnv } from '../../state/env';
import { ago, describeSync } from './syncText';
import { PolicyEditor } from './PolicyEditor';
import { useNow } from '../../state/selectors';

const ACTION_TEXT: Record<string, string> = {
  class_created: 'Class created', unlocked: 'Host unlocked', unlock_failed: 'Wrong passphrase attempt', passphrase_rotated: 'Passphrase changed',
  pairing_created: 'Invite created', pairing_revoked: 'Invite revoked', member_joined: 'Member joined', member_removed: 'Member removed',
  policy_published: 'Policy published', recovery_bundle_exported: 'Recovery bundle exported', transfer_started: 'Administration handed over',
  admin_transferred_in: 'Administration received', admin_recovered: 'Class recovered',
};

/** Never overstates the remaining validity: rounds down, and says so when under a minute. */
export function remainingText(ms: number): string {
  if (ms < 60_000) return 'less than a minute';
  return `${Math.floor(ms / 60_000)} min`;
}

async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast.ok(`${what} copied.`); } catch { toast.error('Could not copy automatically. Select the text and copy it manually.'); }
}

function PassphraseDialog(props: { open: boolean; title: string; description?: string; confirmLabel: string; onClose: () => void; onSubmit: (pw: string) => Promise<boolean> }) {
  return props.open ? <PassphraseForm {...props} /> : null;
}

function PassphraseForm({ title, description, confirmLabel, onClose, onSubmit }: { title: string; description?: string; confirmLabel: string; onClose: () => void; onSubmit: (pw: string) => Promise<boolean> }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); const ok = await onSubmit(pw); setBusy(false); if (ok) onClose(); };
  return (
    <Dialog open onClose={onClose} title={title} description={description} footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void go()}>{confirmLabel}</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); void go(); }}><Field label="Passphrase"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="off" /></Field></form>
    </Dialog>
  );
}

export function AdminPanel({ overview }: { overview: ClassOverview }) {
  const classId = overview.membership.class_id;
  const host = overview.host;
  const api = getClassApi();
  const now = useNow(1_000); // 1 s: the invite countdown must not lag
  const syncByClass = useEnv((s) => s.syncByClass);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [policy, setPolicy] = useState<StoredPolicy | null>(null);
  const [inviteRaw, setInvite] = useState<Invite | null>(null);
  // An expired invite disappears by derivation, not by an effect that sets state.
  const invite = inviteRaw && inviteRaw.expires_at > now ? inviteRaw : null;
  const [qrState, setQrState] = useState<{ uri: string; url: string }>({ uri: '', url: '' });
  const qr = invite && qrState.uri === invite.uri ? qrState.url : '';
  const [ttl, setTtl] = useState(10);
  const [uses, setUses] = useState(30);
  const [dlg, setDlg] = useState<null | 'start' | 'export' | 'rotate' | 'transfer' | 'remove'>(null);
  const [removing, setRemoving] = useState<MemberInfo | null>(null);
  const [bundlePw, setBundlePw] = useState('');
  const [rot, setRot] = useState({ old: '', next: '' });
  const [busy, setBusy] = useState(false);
  const running = !!host?.running;

  const refresh = useCallback(async () => {
    await useEnv.getState().refreshClasses();
    if (!running) return;
    try {
      const [m, a, p] = await Promise.all([api.members(classId), api.audit(classId), api.policy(classId)]);
      setMembers(m); setAudit(a); setPolicy(p);
    } catch { /* shown by status; avoid toast loops while polling */ }
  }, [api, classId, running]);

  useEffect(() => {
    const id = setInterval(() => void refresh(), 5000);
    const first = setTimeout(() => void refresh(), 0);
    return () => { clearInterval(id); clearTimeout(first); };
  }, [refresh]);

  const inviteUri = invite?.uri ?? null;
  useEffect(() => {
    if (!inviteUri) return;
    let alive = true;
    void QRCode.toDataURL(inviteUri, { margin: 0, width: 400, errorCorrectionLevel: 'M' }).then((url) => { if (alive) setQrState({ uri: inviteUri, url }); }).catch(() => undefined);
    return () => { alive = false; };
  }, [inviteUri]);

  const rev = host?.status?.current_revision ?? 0;
  const sync = describeSync(syncByClass[classId] ?? overview.sync, now);
  const roster = useMemo(() => members.filter((m) => m.status === 'active'), [members]);

  const startHost = async (pw: string) => (await attempt(() => api.hostStart({ classId, passphrase: pw }), 'Could not start hosting')).ok && (void refresh(), true);
  const stopHost = async () => { await attempt(() => api.hostStop(classId)); void refresh(); toast.info('Hosting stopped. Members will show “host unreachable” and keep their last policy.'); };
  const makeInvite = async () => { setBusy(true); const r = await attempt(() => api.invite({ classId, ttlMinutes: ttl, maxUses: uses }), 'Could not create an invite'); setBusy(false); if (r.ok) setInvite(r.value); };

  return (
    <div>
      <div className="sec">
        <SectionHead index="01" title="Hosting" />
        <div className="status-line">
          <Pill tone={running ? 'ok' : 'warn'}>{running ? 'Hosting' : 'Not hosting'}</Pill>
          {running && host?.address && <span className="mono">{host.address}</span>}
          {running ? <><span className="muted">{host?.status?.online_count ?? 0} connected · {host?.status?.member_count ?? 0} members · revision {rev}</span><Button size="sm" variant="quiet" onClick={() => void stopHost()}><Square size={13} aria-hidden /> Stop</Button></> : <Button size="sm" variant="primary" onClick={() => setDlg('start')}><Play size={13} aria-hidden /> Unlock and start hosting</Button>}
        </div>
        <p className="muted" style={{ marginTop: 'var(--s-3)', maxWidth: '70ch' }}>
          {running ? 'This computer is the class host. Members must be on the same local network and this app must stay open for them to receive updates. Nothing goes through the internet.' : 'While hosting is off, members keep working with the last policy they received but cannot get changes. Hosting also stops when you close the app.'}
        </p>
        {running && <p className="faint" style={{ fontSize: 'var(--fs-small)', marginTop: 4 }}>This device’s own view: {sync.label}.</p>}
      </div>

      {!running ? (
        <Empty title="Start hosting to manage the class.">Invites, members and policy changes need the host running and unlocked.</Empty>
      ) : (
        <>
          <div className="sec">
            <SectionHead index="02" title="Invite students" />
            {!invite ? (
              <div className="cluster">
                <Field label="Valid for"><Select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}><option value={5}>5 minutes</option><option value={10}>10 minutes</option><option value={15}>15 minutes</option></Select></Field>
                <Field label="Students who can use it"><Input type="number" min={1} max={500} value={uses} onChange={(e) => setUses(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} style={{ width: 120 }} /></Field>
                <Button variant="primary" busy={busy} onClick={() => void makeInvite()} style={{ alignSelf: 'flex-end' }}>Create invite</Button>
              </div>
            ) : (
              <div className="qr-wrap">
                <div className="qr">{qr ? <img src={qr} alt="QR code containing the class join code" /> : <span className="faint">…</span>}</div>
                <div className="stack">
                  <p>Students open <b>Class → Join a class</b> and scan or paste this. It expires in <b>{remainingText(invite.expires_at - now)}</b> and works for up to {invite.max_uses} students.</p>
                  <div className="copy-box"><code aria-label="Join code" style={{ maxWidth: 360 }}>{invite.uri}</code><Button size="sm" onClick={() => void copy(invite.uri, 'Join code')}><Copy size={14} aria-hidden /> Copy</Button></div>
                  <p className="faint" style={{ fontSize: 'var(--fs-small)' }}>The code contains a one-time secret. Share it only with your class. Host address for manual connection: <span className="mono">{invite.addrs.join(', ')}</span></p>
                  <div className="cluster"><Button variant="quiet" size="sm" onClick={() => setInvite(null)}>Hide</Button></div>
                </div>
              </div>
            )}
            <details style={{ marginTop: 'var(--s-4)' }}>
              <summary className="label" style={{ cursor: 'pointer' }}>If a student can’t connect</summary>
              <ul className="privacy-list">
                <li>Both devices must be on the <b>same Wi-Fi or Ethernet</b>. Guest Wi-Fi and some school networks isolate devices from each other, which blocks this completely.</li>
                <li>Your firewall may ask to allow FOCUS OS on private networks — allow it. Nothing is changed automatically.</li>
                <li>If the invite expired, create a new one. If your IP address changed, the host address shown above is updated automatically.</li>
              </ul>
            </details>
          </div>

          <div className="sec">
            <SectionHead index="03" title={`Members · ${roster.length}`}><Button size="sm" variant="quiet" onClick={() => void refresh()}><RefreshCw size={13} aria-hidden /> Refresh</Button></SectionHead>
            {roster.length <= 1 ? <p className="faint" style={{ padding: 'var(--s-3) 0' }}>No one has joined yet. Create an invite above.</p> : null}
            <ul className="rows">
              {roster.map((m) => {
                const d = m.devices.find((x) => x.status === 'active');
                const upToDate = (d?.acked_revision ?? 0) >= rev;
                return (
                  <li className="row" key={m.member_id}>
                    <span className="row-main"><span className="row-title">{m.name}{m.role === 'admin' ? ' (you)' : ''}</span><span className="row-sub">Joined {ago(m.joined_at, now)} · last seen {d?.last_seen_at ? ago(d.last_seen_at, now) : 'never'}</span></span>
                    <div className="row-end">
                      {m.role === 'admin' ? <Pill>Administrator</Pill> : (
                        <>
                          <Pill tone={d?.online ? 'ok' : undefined}>{d?.online ? 'Online' : 'Offline'}</Pill>
                          <Pill tone={rev === 0 ? undefined : upToDate ? 'ok' : 'warn'} title="The newest policy revision this device has confirmed applying">{rev === 0 ? 'No policy yet' : upToDate ? `Has revision ${d?.acked_revision}` : `On revision ${d?.acked_revision ?? 0} of ${rev}`}</Pill>
                          <Button size="sm" variant="quiet" aria-label={`Remove ${m.name}`} onClick={() => { setRemoving(m); setDlg('remove'); }}><UserMinus size={14} aria-hidden /> Remove</Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="sec">
            <SectionHead index="04" title="Class rules" />
            <PolicyEditor key={policy?.envelope.revision ?? 0} classId={classId} current={policy} onPublished={() => void refresh()} />
          </div>

          <div className="sec">
            <SectionHead index="05" title="Activity log" />
            <ul className="rows">
              {audit.slice(0, 12).map((a) => <li className="row" key={a.id} style={{ minHeight: 44 }}><span className="row-main"><span className="row-title">{ACTION_TEXT[a.action] ?? a.action}{a.detail ? ` — ${a.detail}` : ''}</span></span><span className="label">{ago(a.ts, now)}</span></li>)}
            </ul>
            <p className="faint" style={{ fontSize: 'var(--fs-small)' }}>Entries are hash-chained, so edits to the log are detectable.</p>
          </div>

          <div className="sec">
            <SectionHead index="06" title="Security, recovery and handover" />
            <div className="cluster">
              <Button onClick={() => setDlg('rotate')}><KeyRound size={15} aria-hidden /> Change passphrase</Button>
              <Button onClick={() => { setBundlePw(''); setDlg('export'); }}><Download size={15} aria-hidden /> Save recovery bundle</Button>
              <Button variant="danger" onClick={() => { setBundlePw(''); setDlg('transfer'); }}><ArrowRightLeft size={15} aria-hidden /> Hand over administration</Button>
            </div>
            <p className="muted" style={{ marginTop: 'var(--s-3)', maxWidth: '72ch' }}>If this computer is lost and you have no recovery bundle, the class cannot be recovered and members will need a new class. There is no back door — that is what keeps it from being taken over.</p>
          </div>
        </>
      )}

      <PassphraseDialog open={dlg === 'start'} title="Unlock the class" description="Enter your administrator passphrase to start hosting." confirmLabel="Unlock and host" onClose={() => setDlg(null)} onSubmit={startHost} />
      <Dialog open={dlg === 'rotate'} onClose={() => setDlg(null)} title="Change administrator passphrase" footer={<><Button variant="quiet" onClick={() => setDlg(null)}>Cancel</Button><Button variant="primary" onClick={() => void attempt(() => api.rotatePassphrase({ classId, old: rot.old, next: rot.next }), 'Could not change it').then((r) => { if (r.ok) { toast.ok('Passphrase changed.'); setRot({ old: '', next: '' }); setDlg(null); } })}>Change passphrase</Button></>}>
        <div className="stack"><Field label="Current passphrase"><Input type="password" value={rot.old} onChange={(e) => setRot({ ...rot, old: e.target.value })} autoComplete="off" /></Field><Field label="New passphrase" hint="At least 10 characters."><Input type="password" value={rot.next} onChange={(e) => setRot({ ...rot, next: e.target.value })} autoComplete="new-password" /></Field></div>
      </Dialog>
      <Dialog open={dlg === 'export'} onClose={() => setDlg(null)} title="Save a recovery bundle" description="An encrypted file that lets a trusted computer take over this class." footer={<><Button variant="quiet" onClick={() => setDlg(null)}>Cancel</Button><Button variant="primary" onClick={() => void attempt(() => api.exportRecovery({ classId, bundlePassphrase: bundlePw }), 'Could not save').then((r) => { if (r.ok && r.value) { toast.ok(`Saved to ${r.value}. Keep it somewhere safe and offline.`); setDlg(null); } })}>Choose where to save</Button></>}>
        <div className="stack"><Banner tone="info">Anyone with this file <em>and</em> its passphrase can administer the class. Use a different passphrase from your administrator one and store them separately.</Banner><Field label="Bundle passphrase" hint="At least 10 characters."><Input type="password" value={bundlePw} onChange={(e) => setBundlePw(e.target.value)} autoComplete="new-password" autoFocus /></Field></div>
      </Dialog>
      <Dialog open={dlg === 'transfer'} onClose={() => setDlg(null)} title="Hand over administration" footer={<><Button variant="quiet" onClick={() => setDlg(null)}>Keep administering</Button><Button variant="danger" onClick={() => void attempt(() => api.transferBegin({ classId, bundlePassphrase: bundlePw }), 'Handover failed').then((r) => { if (r.ok && r.value) { toast.ok(`Saved to ${r.value}. Give it and its passphrase to the new administrator.`); setDlg(null); void refresh(); } })}>Save file and hand over</Button></>}>
        <div className="stack">
          <Banner tone="danger" title="This cannot be undone.">The class is saved to a file and <b>this computer stops being able to administer or host it</b>. You become an ordinary member. Make sure the file is saved before you hand it on.</Banner>
          <Field label="Passphrase for the handover file" hint="At least 10 characters. Tell the new administrator separately."><Input type="password" value={bundlePw} onChange={(e) => setBundlePw(e.target.value)} autoComplete="new-password" /></Field>
        </div>
      </Dialog>
      <Dialog open={dlg === 'remove'} onClose={() => { setDlg(null); setRemoving(null); }} title={`Remove ${removing?.name ?? ''}?`} footer={<><Button variant="quiet" onClick={() => { setDlg(null); setRemoving(null); }}>Cancel</Button><Button variant="danger" onClick={() => removing && void attempt(() => api.removeMember(classId, removing.member_id), 'Could not remove').then((r) => { if (r.ok) { toast.ok(`${removing.name} was removed.`); setDlg(null); setRemoving(null); void refresh(); } })}>Remove from class</Button></>}>
        <p>Their device loses access immediately and is told it was removed. Their private study data is untouched — it never left their computer.</p>
      </Dialog>
    </div>
  );
}
