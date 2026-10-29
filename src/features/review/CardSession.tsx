import { useEffect, useRef, useState } from 'react';
import { Check, Undo2 } from 'lucide-react';
import { useData } from '../../data/store';
import { useTodayKey } from '../../state/selectors';
import { newId } from '../../data/ids';
import { nowMs } from '../../data/clock';
import { attempt, Button, Meter } from '../../design/ui';
import { type Grade, buildQueue, previewIntervals, review } from '../../domain/srs';
import type { Card } from '../../domain/schemas';
import { diffDays } from '../../domain/time';

const GRADES: { g: Grade; label: string; key: string }[] = [
  { g: 'again', label: 'Again', key: '1' },
  { g: 'hard', label: 'Hard', key: '2' },
  { g: 'good', label: 'Good', key: '3' },
  { g: 'easy', label: 'Easy', key: '4' },
];

const intervalText = (d: number) => (d <= 0 ? 'today' : d === 1 ? '1 day' : d < 30 ? `${d} days` : d < 365 ? `${Math.round(d / 30)} mo` : '1 yr');

export function CardSession({ scope, onExit }: { scope?: { subjectId?: string; topicId?: string }; onExit: () => void }) {
  const settings = useData((s) => s.settings);
  const allCards = useData((s) => s.docs.cards);
  const reviews = useData((s) => s.docs.reviews);
  const today = useTodayKey();

  // The queue is fixed when the session starts so cards don't reshuffle under the student.
  const [initial] = useState(() => {
    const cards = allCards.filter((c) => (!scope?.subjectId || c.subjectId === scope.subjectId) && (!scope?.topicId || c.topicId === scope.topicId));
    const newSeen = reviews.filter((r) => r.day === today && r.wasNew).length;
    return buildQueue(cards, today, { newPerDay: settings.newCardsPerDay, maxReviews: settings.maxReviewsPerDay }, newSeen);
  });
  const [queue, setQueue] = useState<string[]>(initial.ids);
  const [total] = useState(initial.ids.length);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [counts, setCounts] = useState<Record<Grade, number>>({ again: 0, hard: 0, good: 0, easy: 0 });
  const [done, setDone] = useState(0);
  const [last, setLast] = useState<{ before: Card; logId: string; grade: Grade; wasRequeued: boolean } | null>(null);
  const shownAt = useRef(0);

  const card = allCards.find((c) => c.id === queue[0]) ?? null;
  const preview = card ? previewIntervals(card.srs, today) : null;

  useEffect(() => { shownAt.current = Date.now(); }, [card?.id]);

  const grade = async (g: Grade) => {
    if (!card || busy) return;
    setBusy(true);
    const next = review(card.srs, g, today);
    const logId = newId('rev');
    const log = { id: logId, cardId: card.id, at: nowMs(), day: today, grade: g, intervalBefore: card.srs.interval, intervalAfter: next.interval, wasNew: card.srs.state === 'new' };
    const r = await attempt(() => useData.getState().batch([{ put: { c: 'cards', doc: { ...card, srs: next } } }, { put: { c: 'reviews', doc: log } }]), 'Your answer was not saved');
    if (r.ok) {
      // A card that is still due today ("again" while learning) goes to the back of this session.
      const requeue = next.due <= today;
      setQueue((q) => [...q.slice(1), ...(requeue ? [card.id] : [])]);
      setCounts((c) => ({ ...c, [g]: c[g] + 1 }));
      setDone((d) => d + (requeue ? 0 : 1));
      setLast({ before: card, logId, grade: g, wasRequeued: requeue });
      setRevealed(false);
    }
    setBusy(false);
  };

  const undo = async () => {
    if (!last || busy) return;
    setBusy(true);
    const r = await attempt(() => useData.getState().batch([{ put: { c: 'cards', doc: last.before } }, { del: { c: 'reviews', id: last.logId } }]), 'Could not undo');
    if (r.ok) {
      setQueue((q) => [last.before.id, ...(last.wasRequeued ? q.slice(0, -1) : q)]);
      setCounts((c) => ({ ...c, [last.grade]: Math.max(0, c[last.grade] - 1) }));
      setDone((d) => Math.max(0, d - (last.wasRequeued ? 0 : 1)));
      setLast(null);
      setRevealed(false);
    }
    setBusy(false);
  };

  // Keyboard handler always sees the latest closures through this ref (updated after each render).
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keyHandler.current = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!revealed && (e.key === ' ' || e.key === 'Enter') && card) { if (t.tagName !== 'BUTTON') { e.preventDefault(); setRevealed(true); } return; }
      if (revealed) {
        const g = GRADES.find((x) => x.key === e.key);
        if (g) { e.preventDefault(); void grade(g.g); }
      }
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (total === 0 || !card) {
    const reviewed = Object.values(counts).reduce((a, b) => a + b, 0);
    const nextDue = allCards.filter((c) => c.srs.state !== 'new' && c.srs.due > today).map((c) => c.srs.due).sort()[0];
    return (
      <div className="session">
        <div className="empty" style={{ margin: '0 auto', textAlign: 'center' }}>
          <p className="display-italic" style={{ fontSize: 'var(--fs-h2)' }}>{reviewed > 0 ? 'Session complete.' : 'Nothing due right now.'}</p>
          {reviewed > 0 ? (
            <div className="stats" style={{ justifyContent: 'center' }}>
              {GRADES.map((g) => <div className="stat" key={g.g}><b>{counts[g.g]}</b><span className="label">{g.label}</span></div>)}
            </div>
          ) : <p>You are all caught up. Cards come back when it is about time to forget them.</p>}
          {nextDue && <p className="muted">Next card is due in {intervalText(diffDays(today, nextDue))}.</p>}
          <div className="cluster" style={{ justifyContent: 'center', marginTop: 'var(--s-5)' }}>
            {last && <Button variant="quiet" onClick={() => void undo()}><Undo2 size={15} aria-hidden /> Undo last answer</Button>}
            <Button variant="primary" onClick={onExit}><Check size={16} aria-hidden /> Done</Button>
          </div>
          {initial.backlog > 0 && <p className="faint" style={{ marginTop: 'var(--s-4)' }}>{initial.backlog} older cards are still waiting. They keep their place — no need to catch up all at once.</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="session">
      <div className="session-top">
        <Button size="sm" variant="quiet" onClick={onExit}>Leave session</Button>
        <span className="label" aria-live="polite">{done} of {total} done · {queue.length} left</span>
        <Button size="sm" variant="quiet" onClick={() => void undo()} disabled={!last || busy}><Undo2 size={14} aria-hidden /> Undo</Button>
      </div>
      <Meter value={done} max={total} label="Session progress" />
      <div className="flash" aria-live="polite">
        <p className="flash-q">{card.front}</p>
        {revealed && <p className="flash-a" aria-label="Answer">{card.back}</p>}
      </div>
      {!revealed ? (
        <div className="cluster" style={{ justifyContent: 'center', marginTop: 'var(--s-5)' }}>
          <Button variant="primary" size="lg" onClick={() => setRevealed(true)} autoFocus>Show answer <span className="kbd" aria-hidden>Space</span></Button>
        </div>
      ) : (
        <div className="grades" role="group" aria-label="How well did you remember?">
          {GRADES.map((g) => (
            <Button key={g.g} className="grade" data-g={g.g} onClick={() => void grade(g.g)} disabled={busy} autoFocus={g.g === 'good'}>
              <span>{g.label}</span>
              <small>{preview ? intervalText(preview[g.g]) : ''} · {g.key}</small>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
