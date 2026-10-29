import { BackendError, isNative, nativeCall } from './backend';
import type { ClassRule } from '../domain/limits';

export interface Membership {
  class_id: string;
  class_name: string;
  class_pub: string;
  key_id: string;
  host_addrs: string[];
  device_id: string;
  member_id: string;
  role: 'admin' | 'member';
  joined_at: number;
  last_sync_at: number | null;
  last_revision: number;
  status: 'active' | 'removed';
}

export type SyncState =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'live' }
  | { state: 'offline'; reason: string }
  | { state: 'removed' }
  | { state: 'rejected'; reason: string };

export type SyncStatus = SyncState & { last_sync_at: number | null; last_revision: number; host: string | null };

export interface HostStatus {
  class_id: string;
  name: string;
  status: string;
  unlocked: boolean;
  current_revision: number;
  member_count: number;
  online_count: number;
  key_id: string;
}

export interface HostInfo {
  running: boolean;
  unlocked: boolean;
  address: string | null;
  status: HostStatus | null;
}

export interface ClassOverview {
  membership: Membership;
  host: HostInfo | null;
  sync: SyncStatus | null;
}

export interface DeviceInfo {
  device_id: string;
  status: string;
  last_seen_at: number | null;
  acked_revision: number;
  acked_at: number | null;
  online: boolean;
}
export interface MemberInfo {
  member_id: string;
  name: string;
  role: string;
  status: string;
  joined_at: number;
  devices: DeviceInfo[];
}
export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  detail: string;
}
export interface Invite {
  uri: string;
  expires_at: number;
  max_uses: number;
  addrs: string[];
}
export interface LanAddr {
  ip: string;
  interface: string;
  private: boolean;
}
export interface DiscoveredHost {
  class_id: string;
  addrs: string[];
}

export interface PolicyPayload {
  limits: ClassRule[];
  study_goals: { id: string; title: string; target_minutes_per_week: number }[];
  allow_personal_limits: boolean;
  progress_sharing: 'none';
}

export interface StoredPolicy {
  envelope: { class_id: string; revision: number; issued_at: number; payload: PolicyPayload };
  received_at: number;
}

export interface ClassApi {
  available: boolean;
  overview(): Promise<ClassOverview[]>;
  lanAddresses(): Promise<LanAddr[]>;
  create(a: { name: string; adminName: string; passphrase: string; ip?: string }): Promise<ClassOverview>;
  hostStart(a: { classId: string; passphrase: string; ip?: string }): Promise<HostInfo>;
  hostStop(classId: string): Promise<void>;
  invite(a: { classId: string; ttlMinutes: number; maxUses: number }): Promise<Invite>;
  members(classId: string): Promise<MemberInfo[]>;
  removeMember(classId: string, memberId: string): Promise<void>;
  publish(classId: string, payload: PolicyPayload): Promise<number>;
  audit(classId: string): Promise<AuditEntry[]>;
  join(a: { code: string; displayName: string; overrideAddr?: string }): Promise<Membership>;
  discover(timeoutMs: number): Promise<DiscoveredHost[]>;
  syncNow(classId: string): Promise<string>;
  setHostAddr(classId: string, addr: string): Promise<void>;
  leave(classId: string): Promise<void>;
  policy(classId: string): Promise<StoredPolicy | null>;
  exportRecovery(a: { classId: string; bundlePassphrase: string }): Promise<string | null>;
  transferBegin(a: { classId: string; bundlePassphrase: string }): Promise<string | null>;
  restore(a: { bundlePassphrase: string; newPassphrase: string; adminName: string; recovery: boolean }): Promise<Membership | null>;
  rotatePassphrase(a: { classId: string; old: string; next: string }): Promise<void>;
  onSync(cb: (classId: string, status: SyncStatus) => void): Promise<() => void>;
}

const nativeApi: ClassApi = {
  available: true,
  overview: () => nativeCall('class_overview'),
  lanAddresses: () => nativeCall('class_lan_addresses'),
  create: (a) => nativeCall('class_create', { name: a.name, adminName: a.adminName, passphrase: a.passphrase, ip: a.ip ?? null }),
  hostStart: (a) => nativeCall('class_host_start', { classId: a.classId, passphrase: a.passphrase, ip: a.ip ?? null }),
  hostStop: (classId) => nativeCall('class_host_stop', { classId }),
  invite: (a) => nativeCall('class_invite', { classId: a.classId, ttlMinutes: a.ttlMinutes, maxUses: a.maxUses }),
  members: (classId) => nativeCall('class_members', { classId }),
  removeMember: (classId, memberId) => nativeCall('class_remove_member', { classId, memberId }),
  publish: (classId, payload) => nativeCall('class_publish', { classId, payload }),
  audit: (classId) => nativeCall('class_audit', { classId }),
  join: (a) => nativeCall('class_join', { code: a.code, displayName: a.displayName, overrideAddr: a.overrideAddr ?? null }),
  discover: (timeoutMs) => nativeCall('class_discover', { timeoutMs }),
  syncNow: (classId) => nativeCall('class_sync_now', { classId }),
  setHostAddr: (classId, addr) => nativeCall('class_set_host_addr', { classId, addr }),
  leave: (classId) => nativeCall('class_leave', { classId }),
  policy: (classId) => nativeCall('class_policy', { classId }),
  exportRecovery: (a) => nativeCall('class_export_recovery', { classId: a.classId, bundlePassphrase: a.bundlePassphrase }),
  transferBegin: (a) => nativeCall('class_transfer_begin', { classId: a.classId, bundlePassphrase: a.bundlePassphrase }),
  restore: (a) => nativeCall('class_restore', { bundlePassphrase: a.bundlePassphrase, newPassphrase: a.newPassphrase, adminName: a.adminName, recovery: a.recovery }),
  rotatePassphrase: (a) => nativeCall('class_rotate_passphrase', { classId: a.classId, old: a.old, new: a.next }),
  onSync: async (cb) => {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<{ class_id: string; status: SyncStatus }>('class-sync', (e) => cb(e.payload.class_id, e.payload.status));
  },
};

const unsupported = (): never => {
  throw new BackendError('unsupported', 'Classroom features need the FOCUS OS desktop app. This browser preview cannot host or join a class.');
};

const browserApi: ClassApi = {
  available: false,
  overview: async () => [],
  lanAddresses: async () => [],
  create: async () => unsupported(),
  hostStart: async () => unsupported(),
  hostStop: async () => unsupported(),
  invite: async () => unsupported(),
  members: async () => unsupported(),
  removeMember: async () => unsupported(),
  publish: async () => unsupported(),
  audit: async () => unsupported(),
  join: async () => unsupported(),
  discover: async () => unsupported(),
  syncNow: async () => unsupported(),
  setHostAddr: async () => unsupported(),
  leave: async () => unsupported(),
  policy: async () => null,
  exportRecovery: async () => unsupported(),
  transferBegin: async () => unsupported(),
  restore: async () => unsupported(),
  rotatePassphrase: async () => unsupported(),
  onSync: async () => () => {},
};

let override: ClassApi | null = null;
export const getClassApi = (): ClassApi => override ?? (isNative() ? nativeApi : browserApi);
/** Test hook. */
export const setClassApi = (a: ClassApi | null): void => {
  override = a;
};
