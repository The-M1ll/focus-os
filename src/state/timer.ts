import { create } from 'zustand';
import * as T from '../domain/timer';
import { ActiveTimerSchema } from '../domain/schemas';
import { getBackend } from '../data/backend';
import { newId } from '../data/ids';
import { useData } from '../data/store';

export interface TimerStore {
  timer: T.ActiveTimer | null;
  /** Set when the app found a session that was running when it last closed/slept. */
  recoveredNotice: string | null;
  /** Last persistence problem, shown by the UI. */
  persistError: string | null;
  lastSession: T.SessionRecord | null;
  now: number;
  init(now?: number): void;
  start(o: Omit<T.StartOptions, 'id'>, now?: number): void;
  pause(now?: number): void;
  resume(now?: number): void;
  extend(minutes: number, now?: number): void;
  tick(now?: number): void;
  /** End the session and write it to history (and add focus minutes to the linked task). */
  end(now?: number): Promise<T.SessionRecord | null>;
  discard(now?: number): Promise<void>;
  dismissNotice(): void;
}

let chain: Promise<unknown> = Promise.resolve();
let lastPersist = 0;

function persist(t: T.ActiveTimer | null, set: (p: Partial<TimerStore>) => void) {
  const be = getBackend();
  chain = chain
    .then(() => (t ? be.write([{ op: 'put', collection: 'timer', id: 'active', json: JSON.stringify(t) }]) : be.write([{ op: 'delete', collection: 'timer', id: 'active' }])))
    .then(() => set({ persistError: null }))
    .catch((e: Error) => set({ persistError: `Could not save the timer: ${e.message}` }));
}

export const useTimer = create<TimerStore>((set, get) => {
  const apply = (t: T.ActiveTimer | null, now: number, force = false) => {
    set({ timer: t, now });
    if (force || now - lastPersist >= T.HEARTBEAT_MS) {
      lastPersist = now;
      persist(t, set);
    }
  };

  return {
    timer: null,
    recoveredNotice: null,
    persistError: null,
    lastSession: null,
    now: Date.now(),

    init(now = Date.now()) {
      const stored = useData.getState().docs.timer[0];
      if (!stored) return set({ now });
      const parsed = ActiveTimerSchema.safeParse(stored);
      if (!parsed.success) return set({ now });
      const t = parsed.data as T.ActiveTimer;
      const rec = T.recover(t, now);
      const interrupted = rec.status === 'paused' && rec.pauseReason === 'interrupted' && t.status === 'running';
      set({
        timer: rec,
        now,
        recoveredNotice: interrupted
          ? `Your ${t.kind === 'focus' ? 'focus session' : 'break'} was interrupted (the app closed or the computer slept). ${Math.round(T.activeMs(rec) / 60_000)} min were counted; the gap was not.`
          : null,
      });
      if (rec !== t) persist(rec, set);
    },

    start(o, now = Date.now()) {
      if (get().timer && get().timer!.status !== 'finished') return; // one timer at a time
      apply(T.start({ ...o, id: newId('ses') }, now), now, true);
    },
    pause(now = Date.now()) {
      const t = get().timer;
      if (t) apply(T.pause(t, now), now, true);
    },
    resume(now = Date.now()) {
      const t = get().timer;
      if (t) {
        set({ recoveredNotice: null });
        apply(T.resume(t, now), now, true);
      }
    },
    extend(minutes, now = Date.now()) {
      const t = get().timer;
      if (t) apply(T.extend(t, minutes * 60_000, now), now, true);
    },
    tick(now = Date.now()) {
      const t = get().timer;
      if (!t || t.status !== 'running') return set({ now });
      const next = T.tick(t, now);
      apply(next, now, next.status !== 'running');
    },

    async end(now = Date.now()) {
      const t = get().timer;
      if (!t) return null;
      const rec = T.finalize(t, now);
      set({ timer: null, lastSession: rec, recoveredNotice: null });
      lastPersist = 0;
      persist(null, set);
      if (rec.activeMs < 10_000) return rec; // ignore accidental starts
      const d = useData.getState();
      const ops: Parameters<typeof d.batch>[0] = [{ put: { c: 'sessions', doc: rec } }];
      if (rec.kind === 'focus' && rec.taskId) {
        const task = d.docs.tasks.find((x) => x.id === rec.taskId);
        if (task) ops.push({ put: { c: 'tasks', doc: { ...task, actualMin: task.actualMin + Math.round(rec.activeMs / 60_000) } } }); // never marks the task done
      }
      try {
        await d.batch(ops);
      } catch (e) {
        set({ persistError: `The session ended but could not be saved to history: ${(e as Error).message}` });
      }
      return rec;
    },

    async discard() {
      set({ timer: null, recoveredNotice: null });
      lastPersist = 0;
      persist(null, set);
    },

    dismissNotice: () => set({ recoveredNotice: null }),
  };
});
