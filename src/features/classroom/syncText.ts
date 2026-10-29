import type { SyncStatus } from '../../data/classApi';

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export interface SyncView {
  tone: 'ok' | 'warn' | 'danger' | 'info';
  label: string;
  detail: string;
}

/** Words for what is *measured* about the connection. Never claims "live" unless a socket is open. */
export function describeSync(s: SyncStatus | null | undefined, now = Date.now()): SyncView {
  if (!s) return { tone: 'info', label: 'Not started', detail: 'This device has not tried to reach the class host yet.' };
  const last = s.last_sync_at ? `Last policy update ${ago(s.last_sync_at, now)} (revision ${s.last_revision}).` : 'No policy received yet.';
  switch (s.state) {
    case 'live':
      return { tone: 'ok', label: 'Live', detail: `Connected to the class host. ${last}` };
    case 'connecting':
      return { tone: 'info', label: 'Connecting…', detail: `Looking for the class host. ${last}` };
    case 'idle':
      return { tone: 'info', label: 'Idle', detail: last };
    case 'offline':
      return { tone: 'warn', label: 'Host unreachable', detail: `${s.reason}. Your last received policy stays in force and your own study tools keep working. ${last}` };
    case 'removed':
      return { tone: 'danger', label: 'Removed from class', detail: 'The administrator removed this device. Class rules no longer apply.' };
    case 'rejected':
      return { tone: 'danger', label: 'Update refused', detail: `${s.reason}. Your previous policy stays in force.` };
  }
}
