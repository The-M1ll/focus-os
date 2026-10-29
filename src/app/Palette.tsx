import { useMemo, useState } from 'react';
import { BookOpen, CalendarDays, CornerDownLeft, FileText, Gamepad2, Layers, Play, Plus, Search, Settings, ShieldCheck, Timer, Users } from 'lucide-react';
import { Dialog, Kbd } from '../design/ui';
import { useData } from '../data/store';
import { NAV, type Route, useUI } from './ui-state';
import { useTimer } from '../state/timer';

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

const ICONS: Record<Route, React.ReactNode> = {
  today: <Timer size={16} aria-hidden />,
  library: <BookOpen size={16} aria-hidden />,
  review: <Layers size={16} aria-hidden />,
  plan: <CalendarDays size={16} aria-hidden />,
  limits: <ShieldCheck size={16} aria-hidden />,
  apps: <Gamepad2 size={16} aria-hidden />,
  class: <Users size={16} aria-hidden />,
  settings: <Settings size={16} aria-hidden />,
};

/** Context-aware command palette: destinations, creation shortcuts and a local search of notes/cards. */
export function Palette() {
  const open = useUI((s) => s.paletteOpen);
  return open ? <PaletteBody /> : null;
}

function PaletteBody() {
  const route = useUI((s) => s.route);
  const docs = useData((s) => s.docs);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);

  const close = () => useUI.getState().setPalette(false);

  const items = useMemo<Item[]>(() => {
    const ui = useUI.getState();
    const act = (a: NonNullable<typeof ui.pendingAction>, to: Route) => () => {
      useUI.setState({ pendingAction: a });
      ui.go(to);
    };
    const base: Item[] = [
      { id: 'a-focus', label: 'Start a focus session', hint: 'Today', icon: <Play size={16} aria-hidden />, run: () => { ui.go('today'); setTimeout(() => { if (!useTimer.getState().timer) useTimer.getState().start({ kind: 'focus', plannedMs: useData.getState().settings.focus.focusMin * 60_000 }); }, 0); } },
      { id: 'a-task', label: 'New task', hint: 'Plan', icon: <Plus size={16} aria-hidden />, run: act('new-task', 'plan') },
      { id: 'a-note', label: 'New note', hint: 'Library', icon: <Plus size={16} aria-hidden />, run: act('new-note', 'library') },
      { id: 'a-card', label: 'New flashcard', hint: 'Library', icon: <Plus size={16} aria-hidden />, run: act('new-card', 'library') },
      { id: 'a-exam', label: 'New exam', hint: 'Plan', icon: <Plus size={16} aria-hidden />, run: act('new-exam', 'plan') },
      ...NAV.map((n) => ({ id: `n-${n.route}`, label: `Go to ${n.label}`, hint: n.key, icon: ICONS[n.route], run: () => ui.go(n.route) })),
      { id: 'n-settings', label: 'Go to Settings', icon: ICONS.settings, run: () => ui.go('settings') },
    ];
    // Put creation shortcuts for the current section first.
    const ctx: Record<string, string> = { plan: 'a-task', library: 'a-note', today: 'a-focus' };
    const first = ctx[route];
    const ordered = first ? [...base.filter((b) => b.id === first), ...base.filter((b) => b.id !== first)] : base;
    const needle = q.trim().toLowerCase();
    if (!needle) return ordered;
    const matches = ordered.filter((i) => i.label.toLowerCase().includes(needle));
    const notes: Item[] = docs.notes
      .filter((n) => !n.deletedAt && (n.title + ' ' + n.body).toLowerCase().includes(needle))
      .slice(0, 5)
      .map((n) => ({ id: `note-${n.id}`, label: n.title || 'Untitled note', hint: 'Note', icon: <FileText size={16} aria-hidden />, run: () => { useUI.setState({ libSubjectId: n.subjectId, libTopicId: n.topicId ?? null, libTab: 'notes', openNoteId: n.id }); ui.go('library'); } }));
    const cards: Item[] = docs.cards
      .filter((c) => (c.front + ' ' + c.back).toLowerCase().includes(needle))
      .slice(0, 4)
      .map((c) => ({ id: `card-${c.id}`, label: c.front.slice(0, 70), hint: 'Card', icon: <Layers size={16} aria-hidden />, run: () => { useUI.setState({ libSubjectId: c.subjectId, libTopicId: c.topicId ?? null, libTab: 'cards' }); ui.go('library'); } }));
    return [...matches, ...notes, ...cards];
  }, [q, route, docs.notes, docs.cards]);

  const run = (i: Item | undefined) => {
    if (!i) return;
    close();
    i.run();
  };

  return (
    <Dialog open onClose={close} title="Command palette">
      <div className="palette" onKeyDown={(e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); run(items[sel]); }
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Search size={18} aria-hidden className="faint" />
          <input autoFocus className="palette-input" placeholder="Type a command, or search notes and cards" aria-label="Search commands, notes and cards" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[sel] ? `pal-${items[sel]!.id}` : undefined} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); }} />
        </div>
        <ul className="palette-list" id="palette-list" role="listbox" aria-label="Results">
          {items.length === 0 && <li className="palette-item faint">Nothing matches “{q}”.</li>}
          {items.map((i, idx) => (
            <li key={i.id} id={`pal-${i.id}`} role="option" aria-selected={idx === sel} className="palette-item" onMouseEnter={() => setSel(idx)} onClick={() => run(i)}>
              {i.icon}
              <span>{i.label}</span>
              {i.hint && <span className="label">{i.hint}</span>}
            </li>
          ))}
        </ul>
        <p className="faint" style={{ fontSize: 'var(--fs-small)', display: 'flex', gap: 12, padding: '8px 12px 0' }}>
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> move</span>
          <span><Kbd><CornerDownLeft size={10} aria-hidden /></Kbd> open</span>
          <span><Kbd>Esc</Kbd> close</span>
        </p>
      </div>
    </Dialog>
  );
}
