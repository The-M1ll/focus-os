import { BrowserBackend, setBackend, getBackend } from '../data/backend';
import { useData } from '../data/store';
import { useTimer } from './timer';

class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

const T0 = Date.UTC(2026, 2, 2, 10, 0, 0);
const MIN = 60_000;

async function freshApp() {
  setBackend(new BrowserBackend(new MemStorage()));
  useTimer.setState({ timer: null, recoveredNotice: null, lastSession: null, persistError: null });
  await useData.getState().load();
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('timer store', () => {
  beforeEach(freshApp);

  it('start -> tick -> pause -> resume -> end writes a session and adds minutes to the task without completing it', async () => {
    await useData.getState().put('tasks', { id: 'task1', title: 'Worksheet', kind: 'homework', estimateMin: 30, actualMin: 5, priority: 2, status: 'todo', createdAt: 1 });
    useTimer.getState().start({ kind: 'focus', plannedMs: 25 * MIN, taskId: 'task1' }, T0);
    for (let t = T0 + 5000; t <= T0 + 10 * MIN; t += 5000) useTimer.getState().tick(t);
    useTimer.getState().pause(T0 + 10 * MIN);
    useTimer.getState().resume(T0 + 20 * MIN);
    for (let t = T0 + 20 * MIN + 5000; t <= T0 + 25 * MIN; t += 5000) useTimer.getState().tick(t);
    const rec = await useTimer.getState().end(T0 + 25 * MIN);
    expect(rec!.activeMs).toBe(15 * MIN);
    expect(rec!.outcome).toBe('stopped');
    const d = useData.getState().docs;
    expect(d.sessions).toHaveLength(1);
    expect(d.tasks[0]).toMatchObject({ actualMin: 20, status: 'todo' });
    expect(useTimer.getState().timer).toBeNull();
  });

  it('a finished timer does not complete anything by itself', async () => {
    await useData.getState().put('tasks', { id: 'task1', title: 'x', kind: 'homework', estimateMin: 30, actualMin: 0, priority: 2, status: 'todo', createdAt: 1 });
    useTimer.getState().start({ kind: 'focus', plannedMs: MIN, taskId: 'task1' }, T0);
    for (let t = T0 + 5000; t <= T0 + 2 * MIN; t += 5000) useTimer.getState().tick(t);
    expect(useTimer.getState().timer!.status).toBe('finished');
    expect(useData.getState().docs.tasks[0]!.status).toBe('todo');
  });

  it('recovers after an app restart and reports the interruption honestly', async () => {
    useTimer.getState().start({ kind: 'focus', plannedMs: 25 * MIN, label: 'Essay' }, T0);
    for (let t = T0 + 5000; t <= T0 + 7 * MIN; t += 5000) useTimer.getState().tick(t);
    await flush();
    await flush();
    // simulate restart: new process loads from storage 3 hours later
    useTimer.setState({ timer: null });
    await useData.getState().load();
    useTimer.getState().init(T0 + 3 * 60 * MIN);
    const s = useTimer.getState();
    expect(s.timer!.status).toBe('paused');
    expect(s.timer!.pauseReason).toBe('interrupted');
    expect(s.recoveredNotice).toMatch(/7 min were counted/);
    useTimer.getState().resume(T0 + 3 * 60 * MIN);
    expect(useTimer.getState().recoveredNotice).toBeNull();
    expect(useTimer.getState().timer!.status).toBe('running');
  });

  it('only one timer at a time, and accidental starts are not logged', async () => {
    useTimer.getState().start({ kind: 'focus', plannedMs: MIN }, T0);
    const id = useTimer.getState().timer!.id;
    useTimer.getState().start({ kind: 'break', plannedMs: MIN }, T0 + 1);
    expect(useTimer.getState().timer!.id).toBe(id);
    await useTimer.getState().end(T0 + 3000);
    expect(useData.getState().docs.sessions).toHaveLength(0);
  });

  it('surfaces persistence failures instead of hiding them', async () => {
    const be = getBackend();
    be.write = async () => { throw new Error('disk full'); };
    useTimer.getState().start({ kind: 'focus', plannedMs: MIN }, T0);
    await flush();
    await flush();
    expect(useTimer.getState().persistError).toMatch(/disk full/);
  });
});
