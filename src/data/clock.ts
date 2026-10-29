/** Single place that reads the wall clock for event handlers, so it can be stubbed in tests. */
export const nowMs = (): number => Date.now();
