import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bold, CheckSquare, Code, Eye, Heading2, Italic, List, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useData } from '../../data/store';
import { useUI } from '../../app/ui-state';
import { newId } from '../../data/ids';
import { useAutosave } from '../../state/useAutosave';
import { attempt, Button, Empty, IconButton, toast } from '../../design/ui';
import { Markdown } from '../../design/Markdown';
import type { Note, Subject, Topic } from '../../domain/schemas';

interface Draft {
  title: string;
  body: string;
}
const draftEq = (a: Draft, b: Draft) => a.title === b.title && a.body === b.body;

const timeLabel = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function SaveLabel({ status, onRetry }: { status: ReturnType<typeof useAutosave<Draft>>['status']; onRetry: () => void }) {
  if (status.kind === 'error')
    return (
      <span className="status-text" data-kind="error" role="alert">
        <AlertTriangle size={12} aria-hidden /> Couldn’t save: {status.message}
        <Button size="sm" variant="quiet" onClick={onRetry}>Retry</Button>
      </span>
    );
  return (
    <span className="status-text" role="status" aria-live="polite">
      <i className="dot" style={{ color: status.kind === 'saved' ? 'var(--accent)' : 'var(--text-3)' }} />
      {status.kind === 'saving' ? 'Saving…' : status.kind === 'dirty' ? 'Unsaved changes' : status.at ? `Saved ${timeLabel(status.at)}` : 'Saved'}
    </span>
  );
}

function NoteEditor({ note, onClose }: { note: Note; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>({ title: note.title, body: note.body });
  const [preview, setPreview] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const noteRef = useRef(note);
  useEffect(() => { noteRef.current = note; });

  const { status, retry, reset } = useAutosave(
    draft,
    async (d) => {
      const base = useData.getState().docs.notes.find((n) => n.id === noteRef.current.id) ?? noteRef.current;
      await useData.getState().put('notes', { ...base, title: d.title, body: d.body, updatedAt: Date.now() });
    },
    { equals: draftEq },
  );
  useEffect(() => reset({ title: note.title, body: note.body }), [note.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (fn: (ta: HTMLTextAreaElement) => { text: string; selStart: number; selEnd: number }) => {
    const ta = bodyRef.current;
    if (!ta) return;
    const r = fn(ta);
    setDraft((d) => ({ ...d, body: r.text }));
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(r.selStart, r.selEnd); });
  };
  const wrap = (pre: string, post = pre) => edit((ta) => {
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const sel = value.slice(s, e) || 'text';
    return { text: value.slice(0, s) + pre + sel + post + value.slice(e), selStart: s + pre.length, selEnd: s + pre.length + sel.length };
  });
  const linePrefix = (p: string) => edit((ta) => {
    const { selectionStart: s, value } = ta;
    const ls = value.lastIndexOf('\n', s - 1) + 1;
    return { text: value.slice(0, ls) + p + value.slice(ls), selStart: s + p.length, selEnd: s + p.length };
  });

  const remove = async () => {
    const r = await attempt(() => useData.getState().put('notes', { ...useData.getState().docs.notes.find((n) => n.id === note.id)!, title: draft.title, body: draft.body, deletedAt: Date.now() }), 'Could not delete');
    if (r.ok) {
      onClose();
      toast.ok('Note moved to Recently deleted.', { label: 'Undo', run: () => void useData.getState().put('notes', { ...useData.getState().docs.notes.find((n) => n.id === note.id)!, deletedAt: undefined }) });
    }
  };

  return (
    <div>
      <input className="editor-title" aria-label="Note title" placeholder="Untitled note" value={draft.title} maxLength={120} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
      <div className="editor-bar" role="toolbar" aria-label="Formatting">
        <IconButton label="Bold" onClick={() => wrap('**')} disabled={preview}><Bold size={16} aria-hidden /></IconButton>
        <IconButton label="Italic" onClick={() => wrap('*')} disabled={preview}><Italic size={16} aria-hidden /></IconButton>
        <IconButton label="Heading" onClick={() => linePrefix('# ')} disabled={preview}><Heading2 size={16} aria-hidden /></IconButton>
        <IconButton label="Bulleted list" onClick={() => linePrefix('- ')} disabled={preview}><List size={16} aria-hidden /></IconButton>
        <IconButton label="Checklist" onClick={() => linePrefix('- [ ] ')} disabled={preview}><CheckSquare size={16} aria-hidden /></IconButton>
        <IconButton label="Code" onClick={() => wrap('`')} disabled={preview}><Code size={16} aria-hidden /></IconButton>
        <span className="grow" />
        <SaveLabel status={status} onRetry={() => void retry()} />
        <Button size="sm" variant="quiet" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? <><Pencil size={14} aria-hidden /> Edit</> : <><Eye size={14} aria-hidden /> Preview</>}</Button>
        <IconButton label="Delete note" onClick={() => void remove()}><Trash2 size={16} aria-hidden /></IconButton>
      </div>
      {preview ? (
        <Markdown source={draft.body || '*Nothing here yet.*'} />
      ) : (
        <textarea ref={bodyRef} className="editor-body" aria-label="Note body" placeholder="Write freely. Markdown works: # heading, **bold**, - list, - [ ] task." value={draft.body} onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} spellCheck />
      )}
      <p className="faint" style={{ fontSize: 'var(--fs-small)' }}>{draft.body.trim() ? draft.body.trim().split(/\s+/).length : 0} words · saved locally · edits are kept even if the app closes</p>
    </div>
  );
}

export function NotesPane({ subject, topic }: { subject: Subject; topic: Topic | null }) {
  const notes = useData((s) => s.docs.notes);
  const openId = useUI((s) => s.openNoteId);

  const list = useMemo(
    () => notes.filter((n) => !n.deletedAt && n.subjectId === subject.id && (!topic || n.topicId === topic.id)).sort((a, b) => b.updatedAt - a.updatedAt),
    [notes, subject.id, topic],
  );
  const deleted = useMemo(() => notes.filter((n) => n.deletedAt && n.subjectId === subject.id).sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)), [notes, subject.id]);
  const open = notes.find((n) => n.id === openId && !n.deletedAt) ?? null;

  const create = async () => {
    const now = Date.now();
    const n: Note = { id: newId('note'), subjectId: subject.id, topicId: topic?.id, title: '', body: '', createdAt: now, updatedAt: now };
    const r = await attempt(() => useData.getState().put('notes', n), 'Could not create the note');
    if (r.ok) useUI.setState({ openNoteId: n.id });
  };

  // Palette shortcut: "New note".
  useEffect(() => {
    if (useUI.getState().pendingAction === 'new-note') {
      useUI.setState({ pendingAction: null });
      void create();
    }
  });

  // Drop an abandoned empty note when switching away from it.
  const prev = useRef<string | null>(null);
  useEffect(() => {
    const p = prev.current;
    if (p && p !== openId) {
      const n = useData.getState().docs.notes.find((x) => x.id === p);
      if (n && !n.title.trim() && !n.body.trim()) void useData.getState().remove('notes', p).catch(() => undefined);
    }
    prev.current = openId;
  }, [openId]);

  if (list.length === 0 && !open && deleted.length === 0) {
    return (
      <Empty title="No notes here yet." action={<Button variant="primary" onClick={() => void create()}><Plus size={14} aria-hidden /> Write the first note</Button>}>
        Write what you learn in your own words — it is the best way to start remembering it.
      </Empty>
    );
  }

  return (
    <div className="notes-split">
      <div>
        <div className="cluster" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-3)' }}>
          <span className="label">{list.length} note{list.length === 1 ? '' : 's'}</span>
          <Button size="sm" variant="primary" onClick={() => void create()}><Plus size={14} aria-hidden /> New note</Button>
        </div>
        {list.length === 0 ? (
          <Empty title="No notes here yet.">Write what you learn in your own words — it is the best way to start remembering it.</Empty>
        ) : (
          <div>
            {list.map((n) => (
              <button key={n.id} className="note-item" aria-current={n.id === openId} onClick={() => useUI.setState({ openNoteId: n.id })}>
                <span className="row-title" style={{ display: 'block' }}>{n.title || 'Untitled note'}</span>
                <span className="row-sub">{n.body.replace(/[#*`>\-[\]]/g, '').slice(0, 120) || 'Empty'}</span>
              </button>
            ))}
          </div>
        )}
        {deleted.length > 0 && (
          <details style={{ marginTop: 'var(--s-5)' }}>
            <summary className="label" style={{ cursor: 'pointer' }}>Recently deleted · {deleted.length}</summary>
            <ul className="rows">
              {deleted.map((n) => (
                <li key={n.id} className="row">
                  <span className="row-main"><span className="row-title">{n.title || 'Untitled note'}</span><span className="row-sub">Removed for good after 30 days</span></span>
                  <IconButton label={`Restore ${n.title || 'note'}`} onClick={() => void attempt(() => useData.getState().put('notes', { ...n, deletedAt: undefined }))}><RotateCcw size={15} aria-hidden /></IconButton>
                  <IconButton label={`Delete ${n.title || 'note'} permanently`} onClick={() => void attempt(() => useData.getState().remove('notes', n.id))}><Trash2 size={15} aria-hidden /></IconButton>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div>
        {open ? <NoteEditor key={open.id} note={open} onClose={() => useUI.setState({ openNoteId: null })} /> : (
          <div className="empty"><p className="display-italic">Pick a note, or start a new one.</p></div>
        )}
      </div>
    </div>
  );
}

