import { useEffect, useState } from 'react';
import { LifeBuoy, LogIn, Plus } from 'lucide-react';
import { useEnv } from '../../state/env';
import { useData } from '../../data/store';
import { getClassApi } from '../../data/classApi';
import { Banner, Button, Empty, Pill } from '../../design/ui';
import { CreateClassDialog, JoinClassDialog, RestoreDialog } from './CreateJoinDialogs';
import { AdminPanel } from './AdminPanel';
import { MemberPanel } from './MemberPanel';
import { describeSync } from './syncText';
import './classroom.css';

export function ClassPage() {
  const api = getClassApi();
  const classes = useEnv((s) => s.classes);
  const loaded = useEnv((s) => s.loaded);
  const syncByClass = useEnv((s) => s.syncByClass);
  const name = useData((s) => s.settings.displayName);
  const [sel, setSel] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | 'create' | 'join' | 'restore'>(null);

  useEffect(() => { void useEnv.getState().refreshClasses(); }, []);
  const mine = classes.filter((c) => c.membership.status === 'active' || c.membership.status === 'removed');
  const current = mine.find((c) => c.membership.class_id === sel) ?? mine[0];

  const created = (id: string) => { if (id) setSel(id); void useEnv.getState().refreshClasses(); };

  return (
    <div>
      <header className="page-head">
        <div>
          <p className="label">Local-network classroom</p>
          <h1 className="display">Class</h1>
          <p>A teacher’s computer hosts the class for a while; students on the same network connect to it. No internet, account or cloud server is involved.</p>
        </div>
        <div className="cluster">
          <Button onClick={() => setDlg('join')} disabled={!api.available}><LogIn size={15} aria-hidden /> Join a class</Button>
          <Button variant="primary" onClick={() => setDlg('create')} disabled={!api.available}><Plus size={16} aria-hidden /> Create a class</Button>
        </div>
      </header>

      {!api.available && (
        <Banner tone="info" title="Classes need the desktop app.">Hosting and joining use your computer’s local network, which a web page cannot do. Everything else in FOCUS OS works here.</Banner>
      )}

      {mine.length === 0 && (
        <ol className="how" aria-label="How a class works">
          <li><span className="label">01</span><div><b>The teacher’s computer hosts.</b><p>Create a class and keep the app open. It listens on one chosen Wi-Fi/Ethernet address — nothing goes through the internet.</p></div></li>
          <li><span className="label">02</span><div><b>Students join with a code.</b><p>A short-lived invite (QR or text) proves they were invited. Being on the same Wi-Fi is not enough.</p></div></li>
          <li><span className="label">03</span><div><b>Rules arrive signed, live.</b><p>Each change is a new numbered revision. Students verify it against the class key they trusted at joining and confirm receipt.</p></div></li>
          <li><span className="label">04</span><div><b>Private stays private.</b><p>The class sees names, online state and which revision a device has. Never notes, cards, tasks or usage.</p></div></li>
        </ol>
      )}

      {api.available && loaded && mine.length === 0 && (
        <div className="grid-even">
          <Empty title="Teaching a class?" action={<Button variant="primary" onClick={() => setDlg('create')}>Create a class</Button>}>
            Make a class on this computer, invite students with a code, and set shared limits and goals. They update live while you’re hosting.
          </Empty>
          <Empty title="Got a join code?" action={<Button onClick={() => setDlg('join')}>Join a class</Button>}>
            Your administrator will share a code or QR. You only see the rules they set — they never see your notes or study history.
          </Empty>
        </div>
      )}

      {current && (
        <>
          {mine.length > 1 && (
            <div className="class-pick" role="tablist" aria-label="Your classes">
              {mine.map((c) => <button key={c.membership.class_id} role="tab" className="tab" aria-selected={c.membership.class_id === current.membership.class_id} onClick={() => setSel(c.membership.class_id)}>{c.membership.class_name}</button>)}
            </div>
          )}
          <div className="cluster" style={{ marginBottom: 'var(--s-5)' }}>
            <h2 className="display h2">{current.membership.class_name}</h2>
            <Pill tone={current.membership.role === 'admin' ? 'info' : undefined}>{current.membership.role === 'admin' ? 'You administer' : 'Member'}</Pill>
            {current.membership.role === 'member' && <Pill tone={describeSync(syncByClass[current.membership.class_id] ?? current.sync).tone}>{describeSync(syncByClass[current.membership.class_id] ?? current.sync).label}</Pill>}
          </div>
          {current.membership.role === 'admin' ? <AdminPanel key={current.membership.class_id} overview={current} /> : <MemberPanel key={current.membership.class_id} overview={current} />}
        </>
      )}

      {api.available && (
        <div style={{ marginTop: 'var(--s-7)', borderTop: '1px solid var(--line)', paddingTop: 'var(--s-4)' }}>
          <Button variant="quiet" size="sm" onClick={() => setDlg('restore')}><LifeBuoy size={14} aria-hidden /> Take over a class from a recovery bundle</Button>
        </div>
      )}

      <CreateClassDialog open={dlg === 'create'} onClose={() => setDlg(null)} onCreated={created} />
      <JoinClassDialog open={dlg === 'join'} onClose={() => setDlg(null)} onJoined={(m) => created(m.class_id)} defaultName={name} />
      <RestoreDialog open={dlg === 'restore'} onClose={() => setDlg(null)} onRestored={(m) => created(m.class_id)} />
    </div>
  );
}
