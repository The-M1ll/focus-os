import { useEffect, useMemo, useState } from 'react';
import { Archive, FolderPlus, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useData } from '../../data/store';
import { useUI } from '../../app/ui-state';
import { newId } from '../../data/ids';
import { attempt, Banner, Button, Dialog, Empty, Field, Input, Pill, SectionHead, toast, IconButton } from '../../design/ui';
import type { Subject, Topic } from '../../domain/schemas';
import { NotesPane } from './NotesPane';
import { CardsPane } from './CardsPane';
import { QuizzesPane } from './QuizzesPane';
import './library.css';

const COLORS = ['#cfef5b', '#8ab4f8', '#f2b84b', '#ff8a7a', '#c58af9', '#7ee0c3'];

function SubjectDialog({ open, subject, onClose }: { open: boolean; subject: Subject | null; onClose: () => void }) {
  return open ? <SubjectForm subject={subject} onClose={onClose} /> : null;
}

function SubjectForm({ subject, onClose }: { subject: Subject | null; onClose: () => void }) {
  const subjects = useData((s) => s.docs.subjects);
  const [name, setName] = useState(subject?.name ?? '');
  const [color, setColor] = useState(subject?.color ?? COLORS[subjects.length % COLORS.length]!);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const n = name.trim();
    if (!n) return setErr('Give the subject a name.');
    if (subjects.some((s) => s.id !== subject?.id && s.name.toLowerCase() === n.toLowerCase())) return setErr('You already have a subject with that name.');
    const r = await attempt(() => useData.getState().put('subjects', { id: subject?.id ?? newId('sub'), name: n, color, archived: subject?.archived ?? false, createdAt: subject?.createdAt ?? Date.now() }));
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title={subject ? 'Rename subject' : 'New subject'} footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{subject ? 'Save' : 'Create subject'}</Button></>}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Name" error={err}>
          <Input value={name} onChange={(e) => { setName(e.target.value); setErr(null); }} maxLength={60} autoFocus />
        </Field>
        <div className="field">
          <span className="field-label">Colour</span>
          <div className="cluster" role="radiogroup" aria-label="Subject colour">
            {COLORS.map((c) => (
              <button type="button" key={c} role="radio" aria-checked={c === color} aria-label={c} onClick={() => setColor(c)} style={{ width: 28, height: 28, borderRadius: '50%', background: c, border: c === color ? '2px solid var(--text)' : '2px solid transparent', outline: c === color ? '2px solid var(--bg)' : 'none', outlineOffset: -4, cursor: 'pointer' }} />
            ))}
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function TopicDialog({ open, subjectId, topic, onClose }: { open: boolean; subjectId: string; topic: Topic | null; onClose: () => void }) {
  return open ? <TopicForm subjectId={subjectId} topic={topic} onClose={onClose} /> : null;
}

function TopicForm({ subjectId, topic, onClose }: { subjectId: string; topic: Topic | null; onClose: () => void }) {
  const topics = useData((s) => s.docs.topics);
  const [name, setName] = useState(topic?.name ?? '');
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const n = name.trim();
    if (!n) return setErr('Give the topic a name.');
    if (topics.some((t) => t.subjectId === subjectId && t.id !== topic?.id && t.name.toLowerCase() === n.toLowerCase())) return setErr('This subject already has that topic.');
    const r = await attempt(() => useData.getState().put('topics', { id: topic?.id ?? newId('top'), subjectId, name: n, archived: topic?.archived ?? false, createdAt: topic?.createdAt ?? Date.now() }));
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title={topic ? 'Rename topic' : 'New topic'} footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>{topic ? 'Save' : 'Add topic'}</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label="Name" error={err}><Input value={name} onChange={(e) => { setName(e.target.value); setErr(null); }} maxLength={80} autoFocus /></Field>
      </form>
    </Dialog>
  );
}

export function Library() {
  const docs = useData((s) => s.docs);
  const { libSubjectId, libTopicId, libTab } = useUI();
  const [q, setQ] = useState('');
  const [subjectDlg, setSubjectDlg] = useState<{ open: boolean; subject: Subject | null }>({ open: false, subject: null });
  const [topicDlg, setTopicDlg] = useState<{ open: boolean; topic: Topic | null }>({ open: false, topic: null });
  const [confirmDel, setConfirmDel] = useState<Subject | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const subjects = useMemo(() => docs.subjects.filter((s) => showArchived || !s.archived).sort((a, b) => a.name.localeCompare(b.name)), [docs.subjects, showArchived]);
  const subject = docs.subjects.find((s) => s.id === libSubjectId) ?? null;
  const topics = useMemo(() => docs.topics.filter((t) => t.subjectId === subject?.id && !t.archived).sort((a, b) => a.name.localeCompare(b.name)), [docs.topics, subject]);
  const topic = topics.find((t) => t.id === libTopicId) ?? null;

  // Select the first subject by default; fall back if the selected one disappears.
  useEffect(() => {
    if (!subject && subjects[0]) useUI.setState({ libSubjectId: subjects[0].id, libTopicId: null });
  }, [subject, subjects]);

  // Palette: "New note / card" arrives as a one-shot action.
  useEffect(() => {
    const a = useUI.getState().pendingAction;
    if (a === 'new-note') useUI.setState({ libTab: 'notes' });
    if (a === 'new-card') useUI.setState({ libTab: 'cards' });
  }, []);

  // Purge notes deleted more than 30 days ago (explicit, documented retention).
  useEffect(() => {
    const cutoff = Date.now() - 30 * 86_400_000;
    const old = useData.getState().docs.notes.filter((n) => n.deletedAt && n.deletedAt < cutoff);
    if (old.length) void useData.getState().batch(old.map((n) => ({ del: { c: 'notes' as const, id: n.id } }))).catch(() => undefined);
  }, []);

  const countFor = (sid: string) => docs.notes.filter((n) => n.subjectId === sid && !n.deletedAt).length + docs.cards.filter((c) => c.subjectId === sid).length;

  const needle = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (!needle) return null;
    const notes = docs.notes.filter((n) => !n.deletedAt && (n.title + ' ' + n.body).toLowerCase().includes(needle));
    const cards = docs.cards.filter((c) => (c.front + ' ' + c.back).toLowerCase().includes(needle));
    return { notes, cards };
  }, [needle, docs.notes, docs.cards]);

  const doDelete = async (s: Subject) => {
    const ops = [
      ...docs.notes.filter((n) => n.subjectId === s.id).map((n) => ({ del: { c: 'notes' as const, id: n.id } })),
      ...docs.cards.filter((c) => c.subjectId === s.id).map((c) => ({ del: { c: 'cards' as const, id: c.id } })),
      ...docs.quizzes.filter((x) => x.subjectId === s.id).map((x) => ({ del: { c: 'quizzes' as const, id: x.id } })),
      ...docs.topics.filter((t) => t.subjectId === s.id).map((t) => ({ del: { c: 'topics' as const, id: t.id } })),
      { del: { c: 'subjects' as const, id: s.id } },
    ];
    const r = await attempt(() => useData.getState().batch(ops), 'Could not delete the subject');
    if (r.ok) {
      toast.ok(`Deleted “${s.name}” and its contents.`);
      setConfirmDel(null);
      useUI.setState({ libSubjectId: null, libTopicId: null });
    }
  };

  const archive = (s: Subject) => void attempt(() => useData.getState().put('subjects', { ...s, archived: !s.archived })).then((r) => r.ok && toast.ok(s.archived ? `Restored “${s.name}”.` : `Archived “${s.name}”. Its notes and cards are kept.`));

  return (
    <div className="lib">
      <nav className="lib-nav" aria-label="Subjects and topics">
        <Field label="Search notes and cards">
          <div style={{ position: 'relative' }}>
            <Search size={15} aria-hidden style={{ position: 'absolute', left: 12, top: 13, color: 'var(--text-3)' }} />
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" style={{ paddingLeft: 34 }} />
          </div>
        </Field>
        <div className="sec" style={{ marginTop: 'var(--s-5)' }}>
          <SectionHead title="Subjects">
            <IconButton label="New subject" onClick={() => setSubjectDlg({ open: true, subject: null })}><FolderPlus size={17} aria-hidden /></IconButton>
          </SectionHead>
          {subjects.length === 0 ? (
            <p className="faint" style={{ padding: 'var(--s-3) 0' }}>No subjects yet.</p>
          ) : (
            <ul className="rows">
              {subjects.map((s) => (
                <li key={s.id}>
                  <div className="row">
                    <button className="subj-btn" aria-current={s.id === subject?.id} onClick={() => { useUI.setState({ libSubjectId: s.id, libTopicId: null }); setQ(''); }}>
                      <i style={{ background: s.color }} />
                      <span style={{ textDecoration: s.archived ? 'line-through' : undefined }}>{s.name}</span>
                      <span className="count">{countFor(s.id)}</span>
                    </button>
                  </div>
                  {s.id === subject?.id && (
                    <ul className="topic-list">
                      <li><button aria-current={!topic} onClick={() => useUI.setState({ libTopicId: null })}>All topics</button></li>
                      {topics.map((t) => (
                        <li key={t.id}>
                          <button aria-current={t.id === topic?.id} onClick={() => useUI.setState({ libTopicId: t.id })}>
                            <span>{t.name}</span>
                          </button>
                        </li>
                      ))}
                      <li><button onClick={() => setTopicDlg({ open: true, topic: null })}><span><Plus size={12} aria-hidden /> Add topic</span></button></li>
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          <label className="switch" style={{ marginTop: 'var(--s-3)' }}>
            <input type="checkbox" role="switch" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            <span className="track" aria-hidden />
            <span className="faint" style={{ fontSize: 'var(--fs-small)' }}>Show archived</span>
          </label>
        </div>
      </nav>

      <section className="lib-main" aria-label="Library content">
        {results ? (
          <div>
            <h1 className="display">Results for “{q}”</h1>
            <div className="sec" style={{ marginTop: 'var(--s-5)' }}>
              <SectionHead title={`Notes · ${results.notes.length}`} />
              {results.notes.length === 0 ? <p className="faint" style={{ padding: 'var(--s-3) 0' }}>No notes match.</p> : (
                <ul className="rows">{results.notes.map((n) => (
                  <li key={n.id} className="row">
                    <div className="row-main"><span className="row-title">{n.title || 'Untitled note'}</span><span className="row-sub">{docs.subjects.find((s) => s.id === n.subjectId)?.name}</span></div>
                    <Button size="sm" onClick={() => { useUI.setState({ libSubjectId: n.subjectId, libTopicId: n.topicId ?? null, libTab: 'notes', openNoteId: n.id }); setQ(''); }}>Open</Button>
                  </li>))}
                </ul>
              )}
            </div>
            <div className="sec">
              <SectionHead title={`Cards · ${results.cards.length}`} />
              {results.cards.length === 0 ? <p className="faint" style={{ padding: 'var(--s-3) 0' }}>No cards match.</p> : (
                <ul className="rows">{results.cards.map((c) => (
                  <li key={c.id} className="row">
                    <div className="row-main"><span className="row-title card-front">{c.front}</span><span className="row-sub">{c.back}</span></div>
                    <Button size="sm" onClick={() => { useUI.setState({ libSubjectId: c.subjectId, libTopicId: c.topicId ?? null, libTab: 'cards' }); setQ(''); }}>Show</Button>
                  </li>))}
                </ul>
              )}
            </div>
          </div>
        ) : !subject ? (
          <Empty title="Start with a subject." action={<Button variant="primary" onClick={() => setSubjectDlg({ open: true, subject: null })}><FolderPlus size={16} aria-hidden /> Create a subject</Button>}>
            Subjects hold your notes, flashcards and quizzes together — for example “Biology”, with topics like “Cell structure”.
          </Empty>
        ) : (
          <>
            <header style={{ marginBottom: 'var(--s-5)' }}>
              <p className="crumb">{subject.name}{topic ? ` / ${topic.name}` : ''}</p>
              <div className="cluster" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <h1 className="display">{topic?.name ?? subject.name}</h1>
                <div className="cluster">
                  {subject.archived && <Pill tone="warn">Archived</Pill>}
                  <IconButton label="Rename subject" onClick={() => setSubjectDlg({ open: true, subject })}><Pencil size={16} aria-hidden /></IconButton>
                  {topic && <IconButton label="Rename topic" onClick={() => setTopicDlg({ open: true, topic })}><Pencil size={16} aria-hidden /></IconButton>}
                  <IconButton label={subject.archived ? 'Restore subject' : 'Archive subject'} onClick={() => archive(subject)}><Archive size={16} aria-hidden /></IconButton>
                  <IconButton label="Delete subject" onClick={() => setConfirmDel(subject)}><Trash2 size={16} aria-hidden /></IconButton>
                </div>
              </div>
            </header>
            <div className="tabs" role="tablist" aria-label="Library sections">
              {(['notes', 'cards', 'quizzes'] as const).map((t) => (
                <button key={t} role="tab" className="tab" id={`tab-${t}`} aria-selected={libTab === t} aria-controls="lib-panel" onClick={() => useUI.setState({ libTab: t })}>
                  {t === 'notes' ? 'Notes' : t === 'cards' ? 'Flashcards' : 'Quizzes'}
                </button>
              ))}
            </div>
            <div id="lib-panel" role="tabpanel" aria-labelledby={`tab-${libTab}`}>
              {libTab === 'notes' && <NotesPane subject={subject} topic={topic} />}
              {libTab === 'cards' && <CardsPane subject={subject} topic={topic} />}
              {libTab === 'quizzes' && <QuizzesPane subject={subject} topic={topic} />}
            </div>
          </>
        )}
      </section>

      <SubjectDialog open={subjectDlg.open} subject={subjectDlg.subject} onClose={() => setSubjectDlg({ open: false, subject: null })} />
      {subject && <TopicDialog open={topicDlg.open} subjectId={subject.id} topic={topicDlg.topic} onClose={() => setTopicDlg({ open: false, topic: null })} />}
      <Dialog open={!!confirmDel} onClose={() => setConfirmDel(null)} title="Delete this subject?" footer={<><Button variant="quiet" onClick={() => setConfirmDel(null)}>Keep it</Button><Button variant="danger" onClick={() => confirmDel && void doDelete(confirmDel)}>Delete permanently</Button></>}>
        {confirmDel && (
          <div className="stack">
            <Banner tone="danger">This removes <strong>{docs.notes.filter((n) => n.subjectId === confirmDel.id).length} notes</strong>, <strong>{docs.cards.filter((c) => c.subjectId === confirmDel.id).length} flashcards</strong> and <strong>{docs.quizzes.filter((q) => q.subjectId === confirmDel.id).length} quizzes</strong> inside “{confirmDel.name}”. It cannot be undone.</Banner>
            <p className="muted">If you only want it out of the way, archive it instead — everything is kept.</p>
          </div>
        )}
      </Dialog>
    </div>
  );
}
