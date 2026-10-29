import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { attempt, Banner, Button, Dialog, Field, Input, Select, TextArea, toast } from '../../design/ui';
import { getClassApi, type DiscoveredHost, type LanAddr, type Membership } from '../../data/classApi';

export function CreateClassDialog(props: { open: boolean; onClose: () => void; onCreated: (classId: string) => void }) {
  return props.open ? <CreateClassForm onClose={props.onClose} onCreated={props.onCreated} /> : null;
}

function CreateClassForm({ onClose, onCreated }: { onClose: () => void; onCreated: (classId: string) => void }) {
  const [name, setName] = useState('');
  const [admin, setAdmin] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [ip, setIp] = useState('');
  const [addrs, setAddrs] = useState<LanAddr[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ name?: string; admin?: string; pw?: string; pw2?: string }>({});

  useEffect(() => {
    let alive = true;
    void getClassApi().lanAddresses().then((a) => { if (alive) { setAddrs(a); setIp(a[0]?.ip ?? ''); } }).catch(() => { if (alive) setAddrs([]); });
    return () => { alive = false; };
  }, []);

  const submit = async () => {
    const e: typeof err = {};
    if (!name.trim()) e.name = 'Name the class.';
    if (!admin.trim()) e.admin = 'Enter the name members will see.';
    if (pw.length < 10) e.pw = 'Use at least 10 characters. A few random words work well.';
    if (pw2 !== pw) e.pw2 = 'The passphrases don’t match.';
    setErr(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const r = await getClassApi().create({ name: name.trim(), adminName: admin.trim(), passphrase: pw, ip: ip || undefined });
      toast.ok(`“${name.trim()}” is ready. Save a recovery bundle next.`);
      onCreated(r.membership.class_id);
      onClose();
    } catch (e) {
      if ((e as { code?: string }).code === 'created_not_hosting') {
        // The class exists; don't invite a retry (it would create a duplicate). Close and let the admin start hosting.
        toast.warn((e as Error).message);
        onCreated('');
        onClose();
      } else toast.error(`Could not create the class: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Create a class" description="This computer hosts the class. No internet, account or server is needed — only a shared local network." footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void submit()} disabled={addrs.length === 0}>Create and start hosting</Button></>}>
      {addrs.length === 0 && <Banner tone="danger" title="No local network found.">Connect this computer to Wi-Fi or Ethernet first. Students must be able to reach it on the same network.</Banner>}
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Class name" error={err.name}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Grade 10B Physics" /></Field>
        <Field label="Your name (shown to members)" error={err.admin}><Input value={admin} onChange={(e) => setAdmin(e.target.value)} maxLength={64} /></Field>
        <Field label="Administrator passphrase" error={err.pw} hint="Unlocks the class on this computer after a restart. It cannot be recovered if you forget it — keep a recovery bundle."><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
        <Field label="Repeat passphrase" error={err.pw2}><Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>
        {addrs.length > 0 && (
          <Field label="Host on which network" hint="The class is only reachable on this one network interface — never on all of them.">
            <Select value={ip} onChange={(e) => setIp(e.target.value)}>{addrs.map((a) => <option key={a.ip} value={a.ip}>{a.ip} · {a.interface}{a.private ? '' : ' (public address)'}</option>)}</Select>
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function JoinClassDialog(props: { open: boolean; onClose: () => void; onJoined: (m: Membership) => void; defaultName: string }) {
  return props.open ? <JoinClassForm onClose={props.onClose} onJoined={props.onJoined} defaultName={props.defaultName} /> : null;
}

function JoinClassForm({ onClose, onJoined, defaultName }: { onClose: () => void; onJoined: (m: Membership) => void; defaultName: string }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultName);
  const [addr, setAddr] = useState('');
  const [found, setFound] = useState<DiscoveredHost[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ code?: string; name?: string }>({});

  const scan = async () => {
    setScanning(true);
    const r = await attempt(() => getClassApi().discover(3000), 'Search failed');
    setScanning(false);
    if (r.ok) setFound(r.value);
  };

  const submit = async () => {
    const e: typeof err = {};
    if (!code.trim().startsWith('focusos://join/')) e.code = 'Paste the join code the administrator shared (it starts with focusos://join/).';
    if (!name.trim()) e.name = 'Enter the name the class will see.';
    setErr(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const r = await attempt(() => getClassApi().join({ code: code.trim(), displayName: name.trim(), overrideAddr: addr || undefined }), 'Could not join');
    setBusy(false);
    if (r.ok) { toast.ok(`Joined “${r.value.class_name}”.`); onJoined(r.value); onClose(); }
  };

  return (
    <Dialog open onClose={onClose} title="Join a class" description="You need the join code from your class administrator. It expires within minutes." footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void submit()}>Join class</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Join code" error={err.code} hint="Paste the code, or the text shown under the QR code."><TextArea value={code} onChange={(e) => setCode(e.target.value)} rows={3} autoFocus spellCheck={false} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-small)' }} /></Field>
        <Field label="Your name (shown to the administrator)" error={err.name}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} /></Field>
        <div className="banner" data-tone="info" style={{ margin: 0 }}>
          <div className="banner-body">
            <strong>What the administrator can see</strong>
            <ul className="privacy-list">
              <li>Your name, and whether this device is online</li>
              <li>Which class policy revision your device has received</li>
            </ul>
            <p style={{ marginTop: 6 }}>Never your notes, flashcards, tasks, focus sessions or usage.</p>
          </div>
        </div>
        <details>
          <summary className="label" style={{ cursor: 'pointer' }}>Can’t connect? Other options</summary>
          <div className="stack" style={{ marginTop: 'var(--s-3)' }}>
            <div className="cluster">
              <Button size="sm" busy={scanning} onClick={() => void scan()}><Search size={14} aria-hidden /> Look for classes on this network</Button>
              <span className="faint" style={{ fontSize: 'var(--fs-small)' }}>Uses local discovery (mDNS). Some networks block it.</span>
            </div>
            {found && (found.length === 0 ? <p className="muted">Nothing found. Your network may block device discovery — enter the host address below instead.</p> : (
              <ul className="rows">{found.map((h) => <li key={h.class_id} className="row"><span className="row-main"><span className="row-title">Class {h.class_id.slice(0, 8)}…</span><span className="row-sub">{h.addrs.join(', ')}</span></span><Button size="sm" onClick={() => setAddr(h.addrs[0] ?? '')}>Use this address</Button></li>)}</ul>
            ))}
            <Field label="Host address (optional)" hint="Format ip:port, for example 192.168.1.20:47800. Ask the administrator; it is shown on their Class page."><Input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="192.168.1.20:47800" /></Field>
          </div>
        </details>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function RestoreDialog(props: { open: boolean; onClose: () => void; onRestored: (m: Membership) => void }) {
  return props.open ? <RestoreForm onClose={props.onClose} onRestored={props.onRestored} /> : null;
}

function RestoreForm({ onClose, onRestored }: { onClose: () => void; onRestored: (m: Membership) => void }) {
  const [bundlePw, setBundlePw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [name, setName] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (newPw.length < 10) return toast.warn('The new administrator passphrase needs at least 10 characters.');
    if (!name.trim()) return toast.warn('Enter your name.');
    setBusy(true);
    const r = await attempt(() => getClassApi().restore({ bundlePassphrase: bundlePw, newPassphrase: newPw, adminName: name.trim(), recovery }), 'Could not restore');
    setBusy(false);
    if (r.ok && r.value) { toast.ok(`You now administer “${r.value.class_name}”. Start hosting, then tell members to reconnect.`); onRestored(r.value); onClose(); }
    else if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title="Take over a class" description="Use a recovery bundle file created by the previous administrator." footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => void submit()}>Choose file and restore</Button></>}>
      <div className="stack">
        <Field label="Bundle passphrase" hint="Set by whoever exported the bundle."><Input type="password" value={bundlePw} onChange={(e) => setBundlePw(e.target.value)} autoComplete="off" /></Field>
        <Field label="Your name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} /></Field>
        <Field label="New administrator passphrase" hint="At least 10 characters."><Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" /></Field>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="field-label" style={{ fontSize: 'var(--fs-small)', color: 'var(--text-2)', marginBottom: 6 }}>Why are you restoring?</legend>
          <label className="ob-opt" style={{ fontSize: 'var(--fs-body)', fontFamily: 'var(--font-ui)' }}><input type="radio" checked={!recovery} onChange={() => setRecovery(false)} /><span>The previous administrator handed the class to me</span></label>
          <label className="ob-opt" style={{ fontSize: 'var(--fs-body)', fontFamily: 'var(--font-ui)' }}><input type="radio" checked={recovery} onChange={() => setRecovery(true)} /><span>The previous administrator’s computer was lost</span></label>
        </fieldset>
        <Banner tone="info">Members keep their identities. Their devices must learn the new host’s address — they can search for it, or enter it under “Change host address”.</Banner>
      </div>
    </Dialog>
  );
}
