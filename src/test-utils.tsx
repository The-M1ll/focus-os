import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './app/App';
import { BrowserBackend, setBackend } from './data/backend';
import { setClassApi, type ClassApi } from './data/classApi';
import { useData } from './data/store';
import { useEnv } from './state/env';
import { useTimer } from './state/timer';
import { useUI } from './app/ui-state';
import { useToasts } from './design/ui';
import { dayKey } from './domain/time';
import { COLLECTIONS, SettingsSchema } from './domain/schemas';

export class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

export const TODAY = () => dayKey(Date.now(), { timeZone: 'UTC', resetHour: 4 });
export const dayOffset = (n: number) => dayKey(Date.now() + n * 86_400_000, { timeZone: 'UTC', resetHour: 4 });

type Seed = Partial<Record<string, object[]>>;

/** Fresh in-memory app state. `seed` maps collection -> documents. Returns the backend for assertions. */
export async function boot(seed: Seed = {}, opts: { onboarded?: boolean; route?: string; classApi?: ClassApi } = {}) {
  const storage = new MemStorage();
  const be = new BrowserBackend(storage);
  setBackend(be);
  setClassApi(opts.classApi ?? null);
  // Start every test from a genuinely cold app: nothing loaded, nothing left over from the previous test.
  useData.setState({ ready: false, loadError: null, issues: [], save: { kind: 'idle' }, settings: SettingsSchema.parse({}), docs: Object.fromEntries(Object.keys(COLLECTIONS).map((k) => [k, []])) as never });
  useToasts.setState({ items: [] });
  useTimer.setState({ timer: null, recoveredNotice: null, lastSession: null, persistError: null });
  useEnv.setState({ classes: [], policies: [], syncByClass: {}, bridge: null, measured: [], loaded: false });
  useUI.setState({ route: 'today', paletteOpen: false, shortcutsOpen: false, focusTaskId: null, libSubjectId: null, libTopicId: null, libTab: 'notes', openNoteId: null, pendingAction: null, reviewMode: null });
  const withSettings: Seed = { ...seed };
  if (opts.onboarded !== false && !withSettings.settings) withSettings.settings = [{ id: 'main', onboarded: true, displayName: 'Aziza', timeZone: 'UTC', resetHour: 4 }];
  for (const [col, docs] of Object.entries(withSettings)) {
    await be.write((docs ?? []).map((d) => ({ op: 'put' as const, collection: col, id: (d as { id: string }).id, json: JSON.stringify(d) })));
  }
  location.hash = `#/${opts.route ?? 'today'}`;
  useUI.setState({ route: (opts.route ?? 'today') as never });
  const user = userEvent.setup();
  const view = render(<App />);
  return { be, storage, user, ...view };
}

export const subject = (id = 'math', name = 'Mathematics') => ({ id, name, color: '#cfef5b', archived: false, createdAt: 1 });
export const task = (o: Record<string, unknown> = {}) => ({ id: 't1', title: 'Algebra worksheet', subjectId: 'math', kind: 'homework', due: dayOffset(1), estimateMin: 30, actualMin: 0, priority: 2, status: 'todo', createdAt: 1, ...o });
export const card = (o: Record<string, unknown> = {}) => ({ id: 'c1', subjectId: 'math', front: 'What is 2+2?', back: '4', source: 'manual', createdAt: 1, srs: { state: 'review', ease: 2.5, interval: 5, reps: 2, lapses: 0, due: dayOffset(-1) }, ...o });
