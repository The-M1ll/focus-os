import { create } from 'zustand';
import { getClassApi, type ClassOverview, type SyncStatus } from '../data/classApi';
import { getBackend, type BridgeStatus, type MeasuredUsage } from '../data/backend';
import type { ClassPolicyView } from '../domain/limits';

interface EnvState {
  classes: ClassOverview[];
  policies: ClassPolicyView[];
  syncByClass: Record<string, SyncStatus>;
  bridge: BridgeStatus | null;
  measured: MeasuredUsage[];
  loaded: boolean;
  refreshClasses(): Promise<void>;
  refreshUsage(fromDay: string, toDay: string): Promise<void>;
  setSync(classId: string, s: SyncStatus): void;
}

export const useEnv = create<EnvState>((set, get) => ({
  classes: [],
  policies: [],
  syncByClass: {},
  bridge: null,
  measured: [],
  loaded: false,

  async refreshClasses() {
    const api = getClassApi();
    try {
      const classes = await api.overview();
      const policies: ClassPolicyView[] = [];
      for (const c of classes) {
        if (c.membership.status !== 'active') continue;
        const p = await api.policy(c.membership.class_id);
        if (p) {
          policies.push({
            classId: c.membership.class_id,
            className: c.membership.class_name,
            revision: p.envelope.revision,
            receivedAt: p.received_at,
            limits: p.envelope.payload.limits,
            allowPersonalLimits: p.envelope.payload.allow_personal_limits,
          });
        }
      }
      const syncByClass = { ...get().syncByClass };
      for (const c of classes) if (c.sync) syncByClass[c.membership.class_id] = c.sync;
      set({ classes, policies, syncByClass, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  async refreshUsage(fromDay, toDay) {
    const be = getBackend();
    try {
      const [measured, bridge] = await Promise.all([be.measuredUsage(fromDay, toDay), be.bridgeStatus()]);
      set({ measured, bridge });
    } catch {
      /* keep last known values; the Limits screen shows the bridge as unavailable */
    }
  },

  setSync(classId, s) {
    set({ syncByClass: { ...get().syncByClass, [classId]: s } });
  },
}));
