import { useMemo } from 'react';
import { useEnv } from '../../state/env';
import { getBackend } from '../../data/backend';

/** Everything the limit evaluation needs besides the student's own rules. */
export function useLimitInputs() {
  const policies = useEnv((s) => s.policies);
  const measured = useEnv((s) => s.measured);
  const bridge = useEnv((s) => s.bridge);
  return useMemo(
    () => ({
      policies,
      measured: measured.map((m) => ({ day: m.day, platform: m.platform, seconds: m.seconds })),
      extensionLastSeen: bridge?.extension_last_seen ?? 0,
      bridgeUp: bridge?.listening ?? false,
      preview: bridge === null && getBackend().kind === 'browser',
    }),
    [policies, measured, bridge],
  );
}
