/**
 * Persistence backends. The shipped app uses `NativeBackend` (SQLite in Rust, validated and
 * transactional). `BrowserBackend` exists for `npm run dev` in a plain browser and for UI
 * tests; it is NOT the storage the desktop app ships with, and the UI says so.
 */

export interface RawDoc {
  collection: string;
  id: string;
  json: string;
  updated_at: number;
}

export type WriteOp = { op: 'put'; collection: string; id: string; json: string } | { op: 'delete'; collection: string; id: string };

export interface BackupInfo {
  name: string;
  bytes: number;
  modified_ms: number;
}

export interface MeasuredUsage {
  day: string;
  platform: string;
  source: string;
  seconds: number;
  updated_at: number;
}

export interface BridgeStatus {
  listening: boolean;
  address: string | null;
  token: string;
  error: string | null;
  extension_last_seen: number;
}

export interface AppEntry {
  slug: string;
  name: string;
  running: boolean;
  installed: boolean;
  game: boolean;
}

export interface AppsStatus {
  supported: boolean;
  mode: 'close' | 'remind' | 'off';
  day: string;
  /** [slug, seconds the app was open today] */
  usage: [string, number][];
  ignored: string[];
  last_scan_ms: number;
}

export type AppsNotice =
  | { kind: 'closing'; slug: string; label: string; seconds_left: number; why: string }
  | { kind: 'low_time'; slug: string; label: string; seconds_left: number }
  | { kind: 'closed'; slug: string; label: string; why: string }
  | { kind: 'over'; slug: string; label: string; why: string };

export class BackendError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Backend {
  kind: 'native' | 'browser';
  getAll(collection: string): Promise<RawDoc[]>;
  write(ops: WriteOp[]): Promise<void>;
  exportFile(): Promise<string | null>;
  importFile(replace: boolean): Promise<number | null>;
  backupNow(): Promise<BackupInfo>;
  listBackups(): Promise<BackupInfo[]>;
  restoreBackup(name: string): Promise<number>;
  measuredUsage(from: string, to: string): Promise<MeasuredUsage[]>;
  bridgeStatus(): Promise<BridgeStatus | null>;
  bridgeSetRules(rules: unknown): Promise<void>;
  notify(title: string, body: string): Promise<{ delivered: boolean; reason: string | null }>;
  /** Desktop apps. `null`/no-ops in the browser preview, which cannot see or close anything. */
  appsList(): Promise<AppEntry[] | null>;
  appsPush(policy: unknown): Promise<void>;
  appsStatus(): Promise<AppsStatus | null>;
  appsUsageRange(from: string, to: string): Promise<[string, string, number][]>;
  onAppsNotice(cb: (n: AppsNotice) => void): Promise<() => void>;
}

export const isNative = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// ---- native -----------------------------------------------------------------

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const err = e as { code?: string; message?: string } | string;
    if (typeof err === 'string') throw new BackendError('internal', err);
    throw new BackendError(err.code ?? 'internal', err.message ?? 'Unknown native error');
  }
}
export { call as nativeCall };

export class NativeBackend implements Backend {
  kind = 'native' as const;
  getAll = (collection: string) => call<RawDoc[]>('store_get_all', { collection });
  write = async (ops: WriteOp[]) => {
    await call('store_write', { ops });
  };
  exportFile = () => call<string | null>('store_export_file');
  importFile = (replace: boolean) => call<number | null>('store_import_file', { replace });
  backupNow = () => call<BackupInfo>('store_backup_now');
  listBackups = () => call<BackupInfo[]>('store_list_backups');
  restoreBackup = (name: string) => call<number>('store_restore_backup', { name });
  measuredUsage = (from: string, to: string) => call<MeasuredUsage[]>('measured_usage', { fromDay: from, toDay: to });
  bridgeStatus = () => call<BridgeStatus>('bridge_status');
  bridgeSetRules = async (rules: unknown) => {
    await call('bridge_set_rules', { rules });
  };
  notify = (title: string, body: string) => call<{ delivered: boolean; reason: string | null }>('notify', { title, body });
  appsList = () => call<AppEntry[]>('apps_list');
  appsPush = async (policy: unknown) => {
    await call('apps_push', { policy });
  };
  appsStatus = () => call<AppsStatus>('apps_status');
  appsUsageRange = (from: string, to: string) => call<[string, string, number][]>('apps_usage_range', { fromDay: from, toDay: to });
  onAppsNotice = async (cb: (n: AppsNotice) => void) => {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<AppsNotice>('focus://apps-notice', (e) => cb(e.payload));
  };
}

// ---- browser (preview/tests only) -----------------------------------------------

const PREFIX = 'focusos:v1:';

export class BrowserBackend implements Backend {
  kind = 'browser' as const;
  constructor(private storage: Storage = window.localStorage) {}

  private read(collection: string): Record<string, { json: string; updated_at: number }> {
    try {
      return JSON.parse(this.storage.getItem(PREFIX + collection) ?? '{}');
    } catch {
      return {};
    }
  }

  async getAll(collection: string): Promise<RawDoc[]> {
    return Object.entries(this.read(collection)).map(([id, v]) => ({ collection, id, json: v.json, updated_at: v.updated_at }));
  }

  async write(ops: WriteOp[]): Promise<void> {
    // Apply to copies first so a failing setItem leaves nothing half-written (all-or-nothing per collection set).
    const touched = new Map<string, Record<string, { json: string; updated_at: number }>>();
    const now = Date.now();
    for (const op of ops) {
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(op.collection) || !/^[A-Za-z0-9_.:-]{1,64}$/.test(op.id)) throw new BackendError('invalid', 'invalid collection or id');
      const c = touched.get(op.collection) ?? this.read(op.collection);
      if (op.op === 'put') {
        JSON.parse(op.json);
        c[op.id] = { json: op.json, updated_at: now };
      } else delete c[op.id];
      touched.set(op.collection, c);
    }
    const before = new Map<string, string | null>();
    try {
      for (const [col, data] of touched) {
        before.set(col, this.storage.getItem(PREFIX + col));
        this.storage.setItem(PREFIX + col, JSON.stringify(data));
      }
    } catch (e) {
      for (const [col, old] of before) {
        try {
          if (old === null) this.storage.removeItem(PREFIX + col);
          else this.storage.setItem(PREFIX + col, old);
        } catch {
          /* best effort rollback */
        }
      }
      throw new BackendError('storage', `Could not save: ${(e as Error).message}`);
    }
  }

  private snapshot(): string {
    const docs: RawDoc[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i)!;
      if (!k.startsWith(PREFIX)) continue;
      const col = k.slice(PREFIX.length);
      const data = this.read(col);
      for (const [id, v] of Object.entries(data)) docs.push({ collection: col, id, json: v.json, updated_at: v.updated_at });
    }
    return JSON.stringify({ format: 'focus-os-export-v1', exported_at: Date.now(), documents: docs });
  }

  async exportFile(): Promise<string | null> {
    const blob = new Blob([this.snapshot()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'focus-os-export.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return 'focus-os-export.json (downloaded)';
  }

  async importFile(replace: boolean): Promise<number | null> {
    const text = await new Promise<string | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => resolve((await input.files?.[0]?.text()) ?? null);
      input.oncancel = () => resolve(null);
      input.click();
    });
    return text === null ? null : this.importText(text, replace);
  }

  importText(text: string, replace: boolean): number {
    let parsed: { format?: string; documents?: RawDoc[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BackendError('invalid', 'That file is not valid JSON.');
    }
    if (parsed.format !== 'focus-os-export-v1' || !Array.isArray(parsed.documents)) throw new BackendError('invalid', 'That is not a FOCUS OS export.');
    for (const d of parsed.documents) {
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(d.collection) || !/^[A-Za-z0-9_.:-]{1,64}$/.test(d.id)) throw new BackendError('invalid', 'The export contains an invalid entry.');
      JSON.parse(d.json);
    }
    if (replace) this.snapshotBackup('pre-import');
    if (replace) {
      for (let i = this.storage.length - 1; i >= 0; i--) {
        const k = this.storage.key(i)!;
        if (k.startsWith(PREFIX)) this.storage.removeItem(k);
      }
    }
    const byCol = new Map<string, Record<string, { json: string; updated_at: number }>>();
    for (const d of parsed.documents) {
      const c = byCol.get(d.collection) ?? this.read(d.collection);
      c[d.id] = { json: d.json, updated_at: d.updated_at };
      byCol.set(d.collection, c);
    }
    for (const [col, data] of byCol) this.storage.setItem(PREFIX + col, JSON.stringify(data));
    return parsed.documents.length;
  }

  private snapshotBackup(tag: string): BackupInfo {
    const snap = this.snapshot();
    const name = `focus-${tag}-${Date.now()}`;
    this.storage.setItem('focusos:backup:' + name, snap);
    const names = this.backupNames();
    for (const old of names.slice(5)) this.storage.removeItem('focusos:backup:' + old);
    return { name, bytes: snap.length, modified_ms: Date.now() };
  }

  private backupNames(): string[] {
    const names: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i)!;
      if (k.startsWith('focusos:backup:')) names.push(k.slice('focusos:backup:'.length));
    }
    return names.sort().reverse();
  }

  async backupNow() {
    return this.snapshotBackup('manual');
  }
  async listBackups(): Promise<BackupInfo[]> {
    return this.backupNames().map((name) => ({ name, bytes: (this.storage.getItem('focusos:backup:' + name) ?? '').length, modified_ms: Number(name.split('-').pop()) || 0 }));
  }
  async restoreBackup(name: string): Promise<number> {
    const snap = this.storage.getItem('focusos:backup:' + name);
    if (!snap) throw new BackendError('not_found', 'That backup no longer exists.');
    this.snapshotBackup('pre-restore');
    return this.importText(snap, true);
  }
  async measuredUsage(): Promise<MeasuredUsage[]> {
    return [];
  }
  async bridgeStatus(): Promise<BridgeStatus | null> {
    return null;
  }
  async bridgeSetRules(): Promise<void> {}
  async appsList(): Promise<AppEntry[] | null> {
    return null;
  }
  async appsPush(): Promise<void> {}
  async appsStatus(): Promise<AppsStatus | null> {
    return null;
  }
  async appsUsageRange(): Promise<[string, string, number][]> {
    return [];
  }
  async onAppsNotice(): Promise<() => void> {
    return () => {};
  }
  async notify(title: string, body: string) {
    if (typeof Notification === 'undefined') return { delivered: false, reason: 'Notifications are not supported here.' };
    if (Notification.permission !== 'granted') return { delivered: false, reason: 'Notification permission has not been granted.' };
    new Notification(title, { body });
    return { delivered: true, reason: null };
  }
}

let current: Backend | null = null;
export function getBackend(): Backend {
  return (current ??= isNative() ? new NativeBackend() : new BrowserBackend());
}
/** Test hook. */
export function setBackend(b: Backend | null): void {
  current = b;
}
