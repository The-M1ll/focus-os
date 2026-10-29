import { useEffect } from 'react';
import { useData } from '../data/store';
import { useTimer } from '../state/timer';
import { acknowledge, anchorState, dueReminders } from '../domain/wellness';
import { ReminderStateSchema } from '../domain/schemas';
import { getBackend } from '../data/backend';
import { toast } from '../design/ui';
import { SYSTEM_ZONE } from '../domain/time';

/**
 * Evaluates gentle reminders every 20 s. Only counts running FOCUS time, honours quiet hours,
 * delivery preference (in-app / system / off) and snoozing. State is persisted so a restart
 * does not cause a burst of reminders.
 */
export function useRemindersLoop(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      const d = useData.getState();
      const t = useTimer.getState().timer;
      const focusRunning = !!t && t.kind === 'focus' && t.status === 'running';
      const stored = d.docs.reminders[0] ?? ReminderStateSchema.parse({});
      const now = Date.now();
      if (!focusRunning) {
        // Forget the anchor when focus stops, so the next session starts a full interval fresh.
        if (stored.lastEyeAt || stored.lastMoveAt) void d.put('reminders', { ...stored, lastEyeAt: 0, lastMoveAt: 0 }).catch(() => undefined);
        return;
      }
      const anchored = anchorState(stored, now);
      if (anchored !== stored && (anchored.lastEyeAt !== stored.lastEyeAt || anchored.lastMoveAt !== stored.lastMoveAt)) {
        void d.put('reminders', anchored).catch(() => undefined);
        return;
      }
      const tz = d.settings.timeZone || SYSTEM_ZONE();
      const due = dueReminders({ now, tz, config: d.settings.wellness, state: anchored, focusRunning });
      if (due.length === 0) return;
      let next = anchored;
      for (const r of due) {
        toast.info(`${r.title}. ${r.body}`);
        if (d.settings.wellness.delivery === 'system') void getBackend().notify(r.title, r.body);
        next = acknowledge(next, r.kind, now);
      }
      void d.put('reminders', next).catch(() => undefined);
    }, 20_000);
    return () => clearInterval(id);
  }, [enabled]);
}
