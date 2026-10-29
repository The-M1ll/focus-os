import { create } from 'zustand';

export const ROUTES = ['today', 'library', 'review', 'plan', 'limits', 'apps', 'class', 'settings'] as const;
export type Route = (typeof ROUTES)[number];

export const NAV: { route: Route; label: string; key: string }[] = [
  { route: 'today', label: 'Today', key: '1' },
  { route: 'library', label: 'Library', key: '2' },
  { route: 'review', label: 'Review', key: '3' },
  { route: 'plan', label: 'Plan', key: '4' },
  { route: 'limits', label: 'Limits', key: '5' },
  { route: 'apps', label: 'Apps', key: '6' },
  { route: 'class', label: 'Class', key: '7' },
];

const fromHash = (): Route => {
  const h = (typeof location !== 'undefined' ? location.hash : '').replace(/^#\/?/, '').split(/[/?]/)[0] as Route;
  return (ROUTES as readonly string[]).includes(h) ? h : 'today';
};

export interface UIState {
  route: Route;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  /** Task chosen elsewhere that Today should preselect for the next focus session. */
  focusTaskId: string | null;
  libSubjectId: string | null;
  libTopicId: string | null;
  libTab: 'notes' | 'cards' | 'quizzes';
  openNoteId: string | null;
  /** One-shot request for a screen to open its "create" UI (used by the palette). */
  pendingAction: 'new-task' | 'new-note' | 'new-card' | 'new-exam' | null;
  reviewMode: { kind: 'cards'; scope?: { subjectId?: string; topicId?: string } } | { kind: 'quiz'; quizId: string; onlyMistakes?: boolean } | null;
  go(r: Route): void;
  setPalette(v: boolean): void;
  setShortcuts(v: boolean): void;
  set(p: Partial<UIState>): void;
}

export const useUI = create<UIState>((set, get) => ({
  route: fromHash(),
  paletteOpen: false,
  shortcutsOpen: false,
  focusTaskId: null,
  libSubjectId: null,
  libTopicId: null,
  libTab: 'notes',
  openNoteId: null,
  pendingAction: null,
  reviewMode: null,
  go(r) {
    if (get().route !== r) {
      set({ route: r });
      if (typeof history !== 'undefined') history.replaceState(null, '', `#/${r}`);
    }
  },
  setPalette: (v) => set({ paletteOpen: v }),
  setShortcuts: (v) => set({ shortcutsOpen: v }),
  set: (p) => set(p),
}));

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => useUI.setState({ route: fromHash() }));
}
