import { useEffect, useMemo, useState } from 'react';
import { useData } from '../data/store';
import { type DayRules, dayKey, isValidZone, SYSTEM_ZONE } from '../domain/time';

export function useDayRules(): DayRules {
  const tz = useData((s) => s.settings.timeZone);
  const reset = useData((s) => s.settings.resetHour);
  return useMemo(() => ({ timeZone: isValidZone(tz) ? tz : SYSTEM_ZONE(), resetHour: reset }), [tz, reset]);
}

/** Re-renders every `everyMs` (default 30 s) – enough for day rollovers and relative labels. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    const onVis = () => setNow(Date.now());
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [everyMs]);
  return now;
}

export function useTodayKey(): string {
  const rules = useDayRules();
  const now = useNow();
  return dayKey(now, rules);
}
