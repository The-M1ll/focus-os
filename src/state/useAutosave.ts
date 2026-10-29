import { useCallback, useEffect, useRef, useState } from 'react';

export type AutosaveStatus = { kind: 'saved'; at: number | null } | { kind: 'dirty' } | { kind: 'saving' } | { kind: 'error'; message: string };

/**
 * Debounced autosave with honest status. `save` must resolve only after the data is really
 * persisted. Pending edits are flushed on blur-away (visibilitychange/pagehide) and on unmount,
 * so at most `delay` ms of typing can be lost to a hard crash.
 */
export function useAutosave<T>(value: T, save: (v: T) => Promise<void>, opts: { delay?: number; enabled?: boolean; equals?: (a: T, b: T) => boolean } = {}) {
  const { delay = 600, enabled = true, equals = Object.is } = opts;
  const [status, setStatus] = useState<AutosaveStatus>({ kind: 'saved', at: null });
  const latest = useRef(value);
  const saved = useRef(value);
  const saveFn = useRef(save);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  // Keep the refs current. Declared before the debounce effect so it always sees the latest value.
  useEffect(() => {
    saveFn.current = save;
    latest.current = value;
  });

  const run = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (inflight.current) await inflight.current.catch(() => undefined);
    const v = latest.current;
    if (equals(v, saved.current)) return;
    setStatus({ kind: 'saving' });
    const p = saveFn.current(v).then(
      () => {
        saved.current = v;
        // If more edits arrived while saving, stay dirty and let the debounce pick them up.
        setStatus(equals(latest.current, v) ? { kind: 'saved', at: Date.now() } : { kind: 'dirty' });
      },
      (e: Error) => setStatus({ kind: 'error', message: e.message }),
    );
    inflight.current = p;
    await p;
    inflight.current = null;
  }, [equals]);

  useEffect(() => {
    if (!enabled) return;
    if (equals(value, saved.current)) return;
    setStatus((s) => (s.kind === 'saving' ? s : { kind: 'dirty' }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, delay, enabled, equals, run]);

  useEffect(() => {
    const flush = () => { if (!equals(latest.current, saved.current)) void run(); };
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
      flush(); // unmount
    };
  }, [run, equals]);

  /** Mark `v` as the persisted baseline (e.g. after loading a different note). */
  const reset = useCallback((v: T) => {
    saved.current = v;
    latest.current = v;
    if (timer.current) clearTimeout(timer.current);
    setStatus({ kind: 'saved', at: null });
  }, []);

  return { status, flush: run, retry: run, reset };
}
