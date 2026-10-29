import { act, screen, waitFor, within } from '@testing-library/react';
import { boot } from '../../test-utils';
import type { AppEntry, AppsNotice, AppsStatus, BrowserBackend } from '../../data/backend';
import type { ClassApi, ClassOverview, StoredPolicy } from '../../data/classApi';

const NOW = Date.now();
const APPS: AppEntry[] = [
  { slug: 'roblox', name: 'Roblox', running: true, installed: true, game: true },
  { slug: 'minecraft-launcher', name: 'Minecraft Launcher', running: false, installed: true, game: true },
  { slug: 'gimp', name: 'Gimp', running: false, installed: true, game: false },
];

/** Pretends to be the desktop app: lists apps, records pushed policies, lets a test fire a warning. */
function nativeApps(opts: { apps?: AppEntry[]; usage?: [string, number][]; ignored?: string[] } = {}) {
  const pushed: unknown[] = [];
  let notice: (n: AppsNotice) => void = () => undefined;
  const patch = (be: BrowserBackend) => {
    Object.assign(be, {
      kind: 'native',
      appsList: async () => opts.apps ?? APPS,
      appsPush: async (p: unknown) => { pushed.push(p); },
      appsStatus: async (): Promise<AppsStatus> => ({ supported: true, mode: 'close', day: '2026-01-01', usage: opts.usage ?? [], ignored: opts.ignored ?? [], last_scan_ms: NOW }),
      appsUsageRange: async () => [],
      onAppsNotice: async (cb: (n: AppsNotice) => void) => { notice = cb; return () => undefined; },
    });
  };
  return { patch, pushed, fire: (n: AppsNotice) => act(() => notice(n)) };
}

const membership = { class_id: 'c1', class_name: '10B', class_pub: 'pub', key_id: 'k', host_addrs: [], device_id: 'd', member_id: 'm', role: 'member' as const, joined_at: NOW - 1000, last_sync_at: NOW, last_revision: 2, status: 'active' as const };
const classWith = (limits: StoredPolicy['envelope']['payload']['limits'], allow = true): ClassApi => {
  const nope = async () => { throw new Error('not expected'); };
  const overview: ClassOverview[] = [{ membership, host: null, sync: { state: 'live', last_sync_at: NOW, last_revision: 2, host: 'h' } } as unknown as ClassOverview];
  return {
    available: true, lanAddresses: async () => [], create: nope, hostStart: nope, hostStop: nope, invite: nope, members: async () => [], removeMember: nope, publish: nope, audit: async () => [], join: nope, discover: async () => [],
    syncNow: nope, setHostAddr: nope, leave: nope, exportRecovery: nope, transferBegin: nope, restore: nope, rotatePassphrase: nope, onSync: async () => () => undefined,
    overview: async () => overview,
    policy: async () => ({ received_at: NOW, envelope: { class_id: 'c1', revision: 3, issued_at: NOW, payload: { limits, study_goals: [], allow_personal_limits: allow, progress_sharing: 'none' } } }),
  } as unknown as ClassApi;
};

const personal = (platform: string, o: object = {}) => ({ id: 'l1', platform, dailyMinutes: 45, days: [0, 1, 2, 3, 4, 5, 6], allowedStart: null, allowedEnd: null, warnAtPct: 80, enabled: true, createdAt: 1, ...o });
const lastPolicy = (pushed: unknown[]) => pushed[pushed.length - 1] as { mode: string; rules: { slug: string; blocked_now: boolean; budget_secs: number | null; why: string }[] };

describe('Apps (browser preview: nothing can be seen or closed, and the UI must say so)', () => {
  it('explains that the desktop app is needed but still lets a rule be set by name', async () => {
    const { user, be } = await boot({}, { route: 'apps' });
    expect(await screen.findByRole('heading', { name: 'Apps', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Desktop app only')).toBeInTheDocument();
    expect(screen.getByText(/nothing is enforced/i)).toBeInTheDocument();
    expect(screen.getByText(/needs the desktop app/i)).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: /limit an app/i })[0]!);
    const dlg = await screen.findByRole('dialog', { name: /limit an app/i });
    await user.click(within(dlg).getByRole('button', { name: /continue/i }));
    expect(within(dlg).getByText(/type the name of the app/i)).toBeInTheDocument(); // validation, nothing lost
    await user.type(within(dlg).getByLabelText('App name'), 'Roblox');
    expect(within(dlg).getByText(/a program called “roblox”/i)).toBeInTheDocument();
    await user.click(within(dlg).getByRole('button', { name: /continue/i }));
    const rule = await screen.findByRole('dialog', { name: /limit roblox/i });
    await user.click(within(rule).getByRole('button', { name: /save rule/i }));
    await waitFor(async () => {
      const docs = await be.getAll('limits');
      expect(docs.map((d) => JSON.parse(d.json).platform)).toEqual(['app.roblox']);
    });
    const row = (await screen.findByText('Roblox', { selector: 'p' })).closest('[role=listitem]') as HTMLElement;
    expect(within(row).getByText('Not enforced')).toBeInTheDocument();
  });

  it('app rules never appear on the websites page', async () => {
    await boot({ limits: [personal('app.roblox')] }, { route: 'limits' });
    expect(await screen.findByRole('heading', { name: 'Limits', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('app.roblox')).not.toBeInTheDocument();
    expect(screen.queryByText('Roblox', { selector: 'p' })).not.toBeInTheDocument();
  });
});

describe('Apps (desktop app)', () => {
  it('lists what is on the computer, games first, and pushes a personal rule to the monitor', async () => {
    const n = nativeApps({ usage: [['roblox', 20 * 60]] });
    const { user } = await boot({ limits: [personal('app.roblox')] }, { route: 'apps', patchBackend: n.patch });
    const list = await screen.findByRole('list', { name: /apps found on this computer/i });
    const names = within(list).getAllByRole('listitem').map((li) => within(li).getByText(/^(Roblox|Minecraft Launcher|Gimp)$/).textContent);
    expect(names).toEqual(['Roblox', 'Minecraft Launcher', 'Gimp']);
    expect(within(list).getByText(/open now/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /games only/i }));
    expect(within(list).queryByText('Gimp')).not.toBeInTheDocument();
    // The rule in force shows measured open time, the budget and honest enforcement.
    const row = (await screen.findByText('Roblox', { selector: 'p' })).closest('[role=listitem]') as HTMLElement;
    expect(within(row).getByText('Open today').parentElement).toHaveTextContent('Open today 20 min');
    expect(within(row).getByText('Enforced')).toBeInTheDocument();
    expect(within(row).getByText(/warned, then closed/i)).toBeInTheDocument();
    await waitFor(() => expect(lastPolicy(n.pushed)).toMatchObject({ mode: 'close', rules: [{ slug: 'roblox', blocked_now: false, budget_secs: 2700 }] }));
  });

  it('a class rule appears automatically, is marked as the class’s, and is pushed as blocked', async () => {
    const n = nativeApps();
    await boot({}, { route: 'apps', patchBackend: n.patch, classApi: classWith([{ platform: 'app.minecraft-launcher', blocked: true, daily_minutes: null, allowed_windows: [] }]) });
    const row = (await screen.findByText('Minecraft Launcher', { selector: 'p' })).closest('[role=listitem]') as HTMLElement;
    expect(within(row).getByText(/class · 10b/i)).toBeInTheDocument();
    expect(within(row).getByText('Blocked')).toBeInTheDocument();
    await waitFor(() => expect(lastPolicy(n.pushed).rules).toMatchObject([{ slug: 'minecraft-launcher', blocked_now: true, why: 'Blocked by your class (10B).' }]));
  });

  it('a personal rule cannot loosen a class block', async () => {
    const n = nativeApps();
    await boot({ limits: [personal('app.minecraft-launcher', { dailyMinutes: 600 })] }, { route: 'apps', patchBackend: n.patch, classApi: classWith([{ platform: 'app.minecraft-launcher', blocked: true, daily_minutes: null, allowed_windows: [] }]) });
    await waitFor(() => expect(lastPolicy(n.pushed).rules).toMatchObject([{ slug: 'minecraft-launcher', blocked_now: true, budget_secs: null }]));
  });

  it('switching enforcement off is honest everywhere and is what the monitor is told', async () => {
    const n = nativeApps();
    const { user, be } = await boot({ limits: [personal('app.roblox')] }, { route: 'apps', patchBackend: n.patch });
    expect(await screen.findByText('Watching this computer')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /^off$/i }));
    expect(await screen.findByText('Enforcement off')).toBeInTheDocument();
    const row = screen.getByText('Roblox', { selector: 'p' }).closest('[role=listitem]') as HTMLElement;
    expect(within(row).getByText('Not enforced')).toBeInTheDocument();
    await waitFor(() => expect(lastPolicy(n.pushed).mode).toBe('off'));
    await waitFor(async () => expect(JSON.parse((await be.getAll('settings'))[0]!.json).appEnforcement).toBe('off'));
  });

  it('shows the warning the monitor raises, and says when something is protected', async () => {
    const n = nativeApps({ ignored: ['chrome'] });
    await boot({ limits: [personal('app.roblox')] }, { route: 'apps', patchBackend: n.patch });
    expect(await screen.findByText(/chrome is a protected program/i)).toBeInTheDocument();
    await n.fire({ kind: 'closing', slug: 'roblox', label: 'Roblox', seconds_left: 60, why: 'Your time for this app is used up.' });
    expect(await screen.findByText(/roblox will close in 60 s/i)).toBeInTheDocument();
    await n.fire({ kind: 'closed', slug: 'roblox', label: 'Roblox', why: 'Your time for this app is used up.' });
    expect(await screen.findByText(/roblox was closed/i)).toBeInTheDocument();
  });

  it('the class editor adds an app rule by name and publishes it as app.<slug>', async () => {
    const publish = vi.fn(async () => 4);
    const base = classWith([]);
    const admin = { ...membership, role: 'admin' as const };
    const api = { ...base, publish, members: async () => [], overview: async () => [{ membership: admin, host: { running: true, unlocked: true, address: '1.2.3.4:5', status: { class_id: 'c1', name: '10B', status: 'active', unlocked: true, current_revision: 3, member_count: 1, online_count: 1, key_id: 'k' } }, sync: { state: 'live', last_sync_at: NOW, last_revision: 3, host: 'h' } }] } as unknown as ClassApi;
    const { user } = await boot({}, { route: 'class', classApi: api });
    await screen.findByRole('button', { name: /publish revision 4/i }); // the editor has settled
    await user.type(await screen.findByLabelText('App or game name'), 'Roblox');
    await user.click(screen.getByRole('button', { name: /add app rule/i }));
    expect(await screen.findByDisplayValue('Roblox')).toBeDisabled(); // the app row: fixed to that app
    await user.click(screen.getByRole('button', { name: /publish revision 4/i }));
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    const [, payload] = publish.mock.calls[0] as unknown as [string, { limits: { platform: string; daily_minutes: number | null }[] }];
    expect(payload.limits).toMatchObject([{ platform: 'app.roblox', daily_minutes: 30 }]);
  });
});
