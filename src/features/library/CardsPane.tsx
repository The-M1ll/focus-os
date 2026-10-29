import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpenCheck, Pencil, Trash2 } from 'lucide-react';
import { useData } from '../../data/store';
import { useUI } from '../../app/ui-state';
import { newId } from '../../data/ids';
import { useTodayKey } from '../../state/selectors';
import { attempt, Button, Dialog, Empty, Field, IconButton, Pill, TextArea, toast } from '../../design/ui';
import type { Card, Subject, Topic } from '../../domain/schemas';
import { newCardState, retentionSummary } from '../../domain/srs';
import { diffDays } from '../../domain/time';

export function dueLabel(c: Card, today: string): { text: string; tone?: 'ok' | 'warn' | 'info' } {
  if (c.srs.state === 'new') return { text: 'New', tone: 'info' };
  const d = diffDays(today, c.srs.due);
  if (d <= 0) return { text: d === 0 ? 'Due today' : `Overdue ${-d}d`, tone: 'warn' };
  return { text: d === 1 ? 'Tomorrow' : `In ${d} days`, tone: 'ok' };
}

function EditDialog({ card, onClose }: { card: Card | null; onClose: () => void }) {
  return card ? <EditForm key={card.id} card={card} onClose={onClose} /> : null;
}

function EditForm({ card, onClose }: { card: Card; onClose: () => void }) {
  const [front, setFront] = useState(card.front);
  const [back, setBack] = useState(card.back);
  const save = async () => {
    if (!front.trim() || !back.trim()) return toast.warn('Both sides need some text.');
    const r = await attempt(() => useData.getState().put('cards', { ...card, front: front.trim(), back: back.trim() }));
    if (r.ok) onClose();
  };
  return (
    <Dialog open onClose={onClose} title="Edit card" footer={<><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void save()}>Save</Button></>}>
      <div className="stack">
        <Field label="Front (question)"><TextArea value={front} onChange={(e) => setFront(e.target.value)} maxLength={4000} /></Field>
        <Field label="Back (answer)"><TextArea value={back} onChange={(e) => setBack(e.target.value)} maxLength={4000} /></Field>
        <p className="faint">Editing the text keeps the card’s review history and schedule.</p>
      </div>
    </Dialog>
  );
}

export function CardsPane({ subject, topic }: { subject: Subject; topic: Topic | null }) {
  const cards = useData((s) => s.docs.cards);
  const today = useTodayKey();
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [editing, setEditing] = useState<Card | null>(null);
  const frontRef = useRef<HTMLTextAreaElement>(null);

  const list = useMemo(() => cards.filter((c) => c.subjectId === subject.id && (!topic || c.topicId === topic.id)).sort((a, b) => a.srs.due.localeCompare(b.srs.due) || b.createdAt - a.createdAt), [cards, subject.id, topic]);
  const dueCount = list.filter((c) => c.srs.state !== 'new' && c.srs.due <= today).length;
  const summary = retentionSummary(list);

  useEffect(() => {
    if (useUI.getState().pendingAction === 'new-card') {
      useUI.setState({ pendingAction: null });
      frontRef.current?.focus();
    }
  });

  const add = async () => {
    if (!front.trim() || !back.trim()) return toast.warn('Write both a question and its answer.');
    const card: Card = { id: newId('card'), subjectId: subject.id, topicId: topic?.id, front: front.trim(), back: back.trim(), source: 'manual', createdAt: Date.now(), srs: newCardState(today) };
    const r = await attempt(() => useData.getState().put('cards', card), 'Could not add the card');
    if (r.ok) { setFront(''); setBack(''); frontRef.current?.focus(); }
  };

  return (
    <div>
      <form className="card-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <Field label="Front"><TextArea ref={frontRef} rows={2} value={front} onChange={(e) => setFront(e.target.value)} placeholder="A question or prompt" style={{ minHeight: 64 }} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void add(); }} /></Field>
        <Field label="Back"><TextArea rows={2} value={back} onChange={(e) => setBack(e.target.value)} placeholder="The answer" style={{ minHeight: 64 }} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void add(); }} /></Field>
        <Button type="submit" variant="primary">Add card</Button>
      </form>

      <div className="cluster" style={{ justifyContent: 'space-between', margin: 'var(--s-4) 0' }}>
        <span className="label">{list.length} card{list.length === 1 ? '' : 's'}{summary.total ? ` · ${summary.fresh} new · ${summary.learning} learning · ${summary.mature} well known` : ''}</span>
        <Button size="sm" disabled={dueCount + summary.fresh === 0} onClick={() => { useUI.setState({ reviewMode: { kind: 'cards', scope: { subjectId: subject.id, topicId: topic?.id } } }); useUI.getState().go('review'); }}>
          <BookOpenCheck size={14} aria-hidden /> Review {dueCount} due
        </Button>
      </div>

      {list.length === 0 ? (
        <Empty title="No flashcards yet.">Keep each card to one fact. Cards you add are scheduled automatically — you only review them when it is about time to forget.</Empty>
      ) : (
        <ul className="rows">
          {list.map((c) => {
            const d = dueLabel(c, today);
            return (
              <li className="row" key={c.id}>
                <div className="row-main">
                  <span className="row-title card-front">{c.front}</span>
                  <span className="row-sub">{c.back}</span>
                </div>
                <div className="row-end">
                  {c.source === 'quiz-mistake' && <Pill tone="info">From quiz</Pill>}
                  <Pill tone={d.tone}>{d.text}</Pill>
                  <IconButton label={`Edit card: ${c.front.slice(0, 30)}`} onClick={() => setEditing(c)}><Pencil size={15} aria-hidden /></IconButton>
                  <IconButton label={`Delete card: ${c.front.slice(0, 30)}`} onClick={() => void attempt(() => useData.getState().remove('cards', c.id)).then((r) => r.ok && toast.ok('Card deleted.', { label: 'Undo', run: () => void useData.getState().put('cards', c) }))}><Trash2 size={15} aria-hidden /></IconButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <EditDialog card={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
