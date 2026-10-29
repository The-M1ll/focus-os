import { create } from 'zustand';
import { COLLECTIONS, type CollectionName, SettingsSchema, type Settings } from '../domain/schemas';
import type { z } from 'zod';
import { getBackend, type WriteOp } from './backend';

type Docs = { [K in CollectionName]: z.infer<(typeof COLLECTIONS)[K]>[] };
type Doc<K extends CollectionName> = z.infer<(typeof COLLECTIONS)[K]>;

/** `doc` is validated against the collection's Zod schema at runtime; it must carry an `id`. */
export type Op = { put: { c: CollectionName; doc: object } } | { del: { c: CollectionName; id: string } };

export interface LoadIssue {
  collection: string;
  id: string;
  problem: string;
}

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: number } | { kind: 'error'; message: string };

interface DataState {
  ready: boolean;
  loadError: string | null;
  issues: LoadIssue[];
  docs: Docs;
  settings: Settings;
  save: SaveState;
  load(): Promise<void>;
  put<K extends CollectionName>(c: K, doc: Doc<K>): Promise<void>;
  putMany<K extends CollectionName>(c: K, docs: Doc<K>[]): Promise<void>;
  remove(c: CollectionName, id: string): Promise<void>;
  /** Several collections atomically (one native transaction). */
  batch(ops: Op[]): Promise<void>;
  updateSettings(patch: (s: Settings) => Settings): Promise<void>;
  reloadAfterRestore(): Promise<void>;
}

const emptyDocs = (): Docs => Object.fromEntries(Object.keys(COLLECTIONS).map((k) => [k, []])) as unknown as Docs;
const defaultSettings = (): Settings => SettingsSchema.parse({});

// Writes are serialised so persistence order == user action order.
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

export const useData = create<DataState>((set, get) => {
  /** Apply ops in memory, persist, and roll back exactly those docs if persistence fails. */
  async function commit(ops: Op[]): Promise<void> {
    const prev = get().docs;
    const prevSettings = get().settings;
    const next: Docs = { ...prev };
    let settings = prevSettings;
    const writes: WriteOp[] = [];
    for (const o of ops) {
      if ('put' in o) {
        const { c, doc } = o.put;
        const parsed = COLLECTIONS[c].safeParse(doc);
        if (!parsed.success) throw new Error(`Invalid ${c} data: ${parsed.error.issues[0]?.message ?? 'unknown problem'}`);
        const docId = (parsed.data as { id: string }).id;
        const list = (next[c] as { id: string }[]).filter((d) => d.id !== docId);
        (next as Record<string, unknown[]>)[c] = [...list, parsed.data];
        if (c === 'settings') settings = parsed.data as Settings;
        writes.push({ op: 'put', collection: c, id: docId, json: JSON.stringify(parsed.data) });
      } else {
        const { c, id } = o.del;
        (next as Record<string, unknown[]>)[c] = (next[c] as { id: string }[]).filter((d) => d.id !== id);
        writes.push({ op: 'delete', collection: c, id });
      }
    }
    set({ docs: next, settings, save: { kind: 'saving' } });
    try {
      await enqueue(() => getBackend().write(writes));
      set({ save: { kind: 'saved', at: Date.now() } });
    } catch (e) {
      set({ docs: prev, settings: prevSettings, save: { kind: 'error', message: (e as Error).message } });
      throw e;
    }
  }

  return {
    ready: false,
    loadError: null,
    issues: [],
    docs: emptyDocs(),
    settings: defaultSettings(),
    save: { kind: 'idle' },

    async load() {
      const be = getBackend();
      const docs = emptyDocs();
      const issues: LoadIssue[] = [];
      try {
        for (const name of Object.keys(COLLECTIONS) as CollectionName[]) {
          const raw = await be.getAll(name);
          for (const r of raw) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(r.json);
            } catch {
              issues.push({ collection: name, id: r.id, problem: 'not valid JSON' });
              continue;
            }
            const res = COLLECTIONS[name].safeParse(parsed);
            if (res.success) (docs[name] as unknown[]).push(res.data);
            else issues.push({ collection: name, id: r.id, problem: res.error.issues[0]?.message ?? 'does not match the expected shape' });
          }
        }
        const settings = (docs.settings[0] as Settings | undefined) ?? defaultSettings();
        set({ docs, settings, issues, ready: true, loadError: null });
      } catch (e) {
        set({ loadError: (e as Error).message, ready: false });
      }
    },

    put: (c, doc) => commit([{ put: { c, doc } }]),
    putMany: (c, docs) => commit(docs.map((doc) => ({ put: { c, doc } }))),
    remove: (c, id) => commit([{ del: { c, id } }]),
    batch: (ops) => commit(ops),
    updateSettings: (patch) => commit([{ put: { c: 'settings', doc: patch(get().settings) } }]),
    async reloadAfterRestore() {
      set({ ready: false });
      await get().load();
    },
  };
});

export const selectSettings = (s: DataState) => s.settings;
