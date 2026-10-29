import { act, renderHook } from '@testing-library/react';
import { useAutosave } from './useAutosave';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useAutosave', () => {
  it('debounces rapid edits into one save, and reports saved only after the promise resolves', async () => {
    let resolve!: () => void;
    const save = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save, { delay: 500 }), { initialProps: { v: 'a' } });
    rerender({ v: 'ab' });
    rerender({ v: 'abc' });
    expect(result.current.status.kind).toBe('dirty');
    await act(async () => { vi.advanceTimersByTime(499); });
    expect(save).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(2); });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('abc');
    expect(result.current.status.kind).toBe('saving');
    await act(async () => { resolve(); });
    expect(result.current.status.kind).toBe('saved');
  });

  it('surfaces failure and can retry', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save, { delay: 100 }), { initialProps: { v: 'a' } });
    rerender({ v: 'b' });
    await act(async () => { vi.advanceTimersByTime(150); });
    expect(result.current.status).toEqual({ kind: 'error', message: 'disk full' });
    await act(async () => { await result.current.retry(); });
    expect(result.current.status.kind).toBe('saved');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('edits made while a save is in flight are not lost', async () => {
    const resolvers: (() => void)[] = [];
    const save = vi.fn(() => new Promise<void>((r) => resolvers.push(r)));
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save, { delay: 100 }), { initialProps: { v: 'a' } });
    rerender({ v: 'b' });
    await act(async () => { vi.advanceTimersByTime(120); });
    rerender({ v: 'bc' }); // typed during the first save
    await act(async () => { resolvers[0]!(); });
    expect(result.current.status.kind).toBe('dirty');
    await act(async () => { vi.advanceTimersByTime(120); });
    await act(async () => { resolvers[1]!(); });
    expect(save).toHaveBeenLastCalledWith('bc');
    expect(result.current.status.kind).toBe('saved');
  });

  it('flushes pending edits when unmounting', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender, unmount } = renderHook(({ v }) => useAutosave(v, save, { delay: 5000 }), { initialProps: { v: 'a' } });
    rerender({ v: 'typed just before closing' });
    unmount();
    await act(async () => { await Promise.resolve(); });
    expect(save).toHaveBeenCalledWith('typed just before closing');
  });

  it('does nothing when the value is unchanged', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ v }) => useAutosave(v, save, { delay: 50 }), { initialProps: { v: 'same' } });
    rerender({ v: 'same' });
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(save).not.toHaveBeenCalled();
  });
});
