import { BrowserBackend, BackendError, setBackend, type Backend } from './backend';
import { useData } from './store';

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

const subject = (id = 's1', name = 'Maths') => ({ id, name, color: '#C8F169', archived: false, createdAt: 1 });

beforeEach(() => {
  setBackend(new BrowserBackend(new MemStorage()));
  useData.setState({ ready: false, issues: [], docs: Object.fromEntries(Object.keys(useData.getState().docs).map((k) => [k, []])) as never });
});

describe('data store', () => {
  it('persists, reloads, and shows saved state only after the write succeeds', async () => {
    await useData.getState().load();
    await useData.getState().put('subjects', subject());
    expect(useData.getState().save.kind).toBe('saved');
    await useData.getState().load();
    expect(useData.getState().docs.subjects).toHaveLength(1);
  });

  it('rolls back memory and reports an error when persistence fails', async () => {
    await useData.getState().load();
    const failing: Backend = Object.assign(Object.create(Object.getPrototypeOf(new BrowserBackend(new MemStorage()))), {
      kind: 'browser',
      getAll: async () => [],
      write: async () => { throw new BackendError('storage', 'disk full'); },
    });
    setBackend(failing);
    await expect(useData.getState().put('subjects', subject())).rejects.toThrow('disk full');
    expect(useData.getState().docs.subjects).toHaveLength(0);
    expect(useData.getState().save).toEqual({ kind: 'error', message: 'disk full' });
  });

  it('rejects invalid documents before touching storage', async () => {
    await useData.getState().load();
    await expect(useData.getState().put('subjects', { ...subject(), name: '   ' })).rejects.toThrow(/Invalid subjects/);
    expect(useData.getState().docs.subjects).toHaveLength(0);
  });

  it('quarantines corrupt stored documents instead of crashing, and keeps the good ones', async () => {
    const storage = new MemStorage();
    const be = new BrowserBackend(storage);
    setBackend(be);
    await be.write([
      { op: 'put', collection: 'subjects', id: 'ok', json: JSON.stringify(subject('ok')) },
      { op: 'put', collection: 'subjects', id: 'bad', json: JSON.stringify({ id: 'bad', name: '' }) },
      { op: 'put', collection: 'subjects', id: 'junk', json: '{"x":1}' },
    ]);
    storage.setItem('focusos:v1:notes', '{"n":{"json":"{{{","updated_at":1}}');
    await useData.getState().load();
    expect(useData.getState().docs.subjects.map((s) => s.id)).toEqual(['ok']);
    expect(useData.getState().issues.map((i) => `${i.collection}/${i.id}`).sort()).toEqual(['notes/n', 'subjects/bad', 'subjects/junk']);
    // the bad documents are still in storage (never silently deleted)
    expect(JSON.parse(storage.getItem('focusos:v1:subjects')!)).toHaveProperty('bad');
  });

  it('applies several operations atomically', async () => {
    await useData.getState().load();
    await useData.getState().batch([{ put: { c: 'subjects', doc: subject('a') } }, { put: { c: 'subjects', doc: subject('b', 'Art') } }]);
    await useData.getState().batch([{ del: { c: 'subjects', id: 'a' } }]);
    expect(useData.getState().docs.subjects.map((s) => s.id)).toEqual(['b']);
  });

  it('settings default sensibly on a fresh install', async () => {
    await useData.getState().load();
    const s = useData.getState().settings;
    expect(s.onboarded).toBe(false);
    expect(s.focus.focusMin).toBe(25);
    expect(s.wellness.quiet.enabled).toBe(true);
  });
});

describe('browser backend export/import', () => {
  it('round-trips and validates imports without partial writes', async () => {
    const be = new BrowserBackend(new MemStorage());
    await be.write([{ op: 'put', collection: 'cards', id: 'c1', json: '{"a":1}' }]);
    const snap = JSON.stringify({ format: 'focus-os-export-v1', documents: [{ collection: 'cards', id: 'c2', json: '{"b":2}', updated_at: 5 }] });
    expect(be.importText(snap, true)).toBe(1);
    expect((await be.getAll('cards')).map((d) => d.id)).toEqual(['c2']);
    expect(() => be.importText('nope', true)).toThrow(/valid JSON/);
    expect(() => be.importText(JSON.stringify({ format: 'x', documents: [] }), true)).toThrow(/not a FOCUS OS export/);
    expect(() => be.importText(JSON.stringify({ format: 'focus-os-export-v1', documents: [{ collection: '../x', id: '1', json: '{}', updated_at: 1 }] }), true)).toThrow(/invalid entry/);
    expect((await be.getAll('cards')).map((d) => d.id)).toEqual(['c2']);
  });

  it('restoring a backup takes a safety copy first', async () => {
    const be = new BrowserBackend(new MemStorage());
    await be.write([{ op: 'put', collection: 'cards', id: 'old', json: '{}' }]);
    const b = await be.backupNow();
    await be.write([{ op: 'put', collection: 'cards', id: 'new', json: '{}' }]);
    await be.restoreBackup(b.name);
    expect((await be.getAll('cards')).map((d) => d.id)).toEqual(['old']);
    expect((await be.listBackups()).some((x) => x.name.includes('pre-restore'))).toBe(true);
  });
});
