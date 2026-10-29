import { screen, waitFor, within } from '@testing-library/react';
import { boot } from '../../test-utils';
import { type ClassApi, type ClassOverview, type MemberInfo, type StoredPolicy, type SyncStatus } from '../../data/classApi';
import { describeSync } from './syncText';
import { remainingText } from './AdminPanel';
import { toPayload } from './PolicyEditor';
import { useEnv } from '../../state/env';

const NOW = Date.now();
const membership = (role: 'admin' | 'member', o = {}) => ({ class_id: 'c1', class_name: 'Physics 11A', class_pub: 'pub', key_id: 'k', host_addrs: ['192.168.1.20:47800'], device_id: 'd', member_id: 'm', role, joined_at: NOW - 3600_000, last_sync_at: NOW - 120_000, last_revision: 2, status: 'active' as const, ...o });
const policy = (rev = 2): StoredPolicy => ({ received_at: NOW - 120_000, envelope: { class_id: 'c1', revision: rev, issued_at: NOW, payload: { limits: [{ platform: 'tiktok', blocked: false, daily_minutes: 20, allowed_windows: [] }, { platform: 'discord', blocked: true, daily_minutes: null, allowed_windows: [] }], study_goals: [{ id: 'g', title: 'Read 30 pages', target_minutes_per_week: 180 }], allow_personal_limits: false, progress_sharing: 'none' } } });

function fakeApi(over: Partial<ClassApi> & { overview: ClassApi['overview'] }): ClassApi {
  const nope = async () => { throw new Error('not expected in this test'); };
  return {
    available: true, lanAddresses: async () => [{ ip: '192.168.1.20', interface: 'wlan0', private: true }], create: nope, hostStart: nope, hostStop: async () => undefined,
    invite: nope, members: async () => [], removeMember: async () => undefined, publish: nope, audit: async () => [], join: nope, discover: async () => [], syncNow: async () => 'Duplicate(2)',
    setHostAddr: async () => undefined, leave: async () => undefined, policy: async () => policy(), exportRecovery: async () => null, transferBegin: async () => null, restore: async () => null,
    rotatePassphrase: async () => undefined, onSync: async () => () => undefined, ...over,
  } as ClassApi;
}

const members = (acked: number): MemberInfo[] => [
  { member_id: 'a', name: 'Ms. Admin', role: 'admin', status: 'active', joined_at: NOW - 7200_000, devices: [{ device_id: 'da', status: 'active', last_seen_at: NOW, acked_revision: 2, acked_at: NOW, online: true }] },
  { member_id: 's1', name: 'Aziza', role: 'member', status: 'active', joined_at: NOW - 3600_000, devices: [{ device_id: 'd1', status: 'active', last_seen_at: NOW - 5000, acked_revision: acked, acked_at: NOW, online: true }] },
  { member_id: 's2', name: 'Bek', role: 'member', status: 'active', joined_at: NOW - 3000_000, devices: [{ device_id: 'd2', status: 'active', last_seen_at: NOW - 900_000, acked_revision: 1, acked_at: NOW, online: false }] },
];

const hosting = (m: ReturnType<typeof membership>): ClassOverview => ({ membership: m, host: { running: true, unlocked: true, address: '192.168.1.20:47800', status: { class_id: 'c1', name: 'Physics 11A', status: 'active', unlocked: true, current_revision: 2, member_count: 3, online_count: 1, key_id: 'k' } }, sync: { state: 'live', last_sync_at: NOW, last_revision: 2, host: '192.168.1.20:47800' } });

describe('Class page without the desktop app', () => {
  it('explains that classes need the desktop app and does not pretend to work', async () => {
    await boot({}, { route: 'class' });
    expect(await screen.findByText(/classes need the desktop app/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create a class/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /join a class/i })).toBeDisabled();
  });
});

describe('Class page: administrator', () => {
  it('shows hosting status, honest sync state per member, and who is behind', async () => {
    await boot({}, { route: 'class', classApi: fakeApi({ overview: async () => [hosting(membership('admin'))], members: async () => members(1) }) });
    expect(await screen.findByText('Hosting', { selector: '.pill' })).toBeInTheDocument();
    expect(screen.getByText('192.168.1.20:47800')).toBeInTheDocument();
    expect(await screen.findByText('Aziza')).toBeInTheDocument();
    const az = screen.getByText('Aziza').closest('li')!;
    expect(within(az).getByText('Online')).toBeInTheDocument();
    expect(within(az).getByText(/on revision 1 of 2/i)).toBeInTheDocument(); // behind: not "synced"
    const bek = screen.getByText('Bek').closest('li')!;
    expect(within(bek).getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText(/this app must stay open/i)).toBeInTheDocument();
  });

  it('refuses to manage the class while the host is stopped, and says why', async () => {
    const ov = hosting(membership('admin'));
    ov.host = { running: false, unlocked: false, address: null, status: null };
    await boot({}, { route: 'class', classApi: fakeApi({ overview: async () => [ov] }) });
    expect(await screen.findByText('Not hosting')).toBeInTheDocument();
    expect(screen.getByText(/members keep working with the last policy they received but cannot get changes/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create invite/i })).not.toBeInTheDocument();
  });

  it('creates an invite and shows a QR image, the code, an expiry and the manual address', async () => {
    const invite = vi.fn(async () => ({ uri: 'focusos://join/abc123', expires_at: Date.now() + 10 * 60_000, max_uses: 30, addrs: ['192.168.1.20:47800'] }));
    const { user } = await boot({}, { route: 'class', classApi: fakeApi({ overview: async () => [hosting(membership('admin'))], members: async () => members(2), invite }) });
    await user.click(await screen.findByRole('button', { name: /create invite/i }));
    expect(await screen.findByAltText(/qr code containing the class join code/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Join code')).toHaveTextContent('focusos://join/abc123');
    expect(screen.getByText(/expires in/i)).toHaveTextContent(/10 min/);
    expect(invite).toHaveBeenCalledWith({ classId: 'c1', ttlMinutes: 10, maxUses: 30 });
  });

  it('removal asks first, then calls the API for exactly that member', async () => {
    const removeMember = vi.fn(async () => undefined);
    const { user } = await boot({}, { route: 'class', classApi: fakeApi({ overview: async () => [hosting(membership('admin'))], members: async () => members(2), removeMember }) });
    await user.click(await screen.findByRole('button', { name: 'Remove Aziza' }));
    const dlg = await screen.findByRole('dialog', { name: /remove aziza/i });
    expect(within(dlg).getByText(/never left their computer/i)).toBeInTheDocument();
    expect(removeMember).not.toHaveBeenCalled();
    await user.click(within(dlg).getByRole('button', { name: /remove from class/i }));
    await waitFor(() => expect(removeMember).toHaveBeenCalledWith('c1', 's1'));
  });

  it('policy editor validates, shows unpublished state, and publishes the exact payload', async () => {
    const publish = vi.fn(async () => 3);
    const { user } = await boot({}, { route: 'class', classApi: fakeApi({ overview: async () => [hosting(membership('admin'))], members: async () => members(2), publish }) });
    const publishBtn = await screen.findByRole('button', { name: /publish revision 3/i });
    expect(publishBtn).toBeDisabled(); // nothing changed yet
    expect(screen.getByText('Matches revision 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /add website rule/i }));
    expect(screen.getByText('Unpublished changes')).toBeInTheDocument();
    expect(publishBtn).toBeEnabled();
    await user.click(publishBtn);
    await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    const [cid, payload] = publish.mock.calls[0] as unknown as [string, { limits: { platform: string }[]; allow_personal_limits: boolean; progress_sharing: string }];
    expect(cid).toBe('c1');
    expect(payload.limits.map((l) => l.platform)).toEqual(expect.arrayContaining(['tiktok', 'discord']));
    expect(payload.limits.length).toBe(3);
    expect(payload.allow_personal_limits).toBe(false);
    expect(payload.progress_sharing).toBe('none'); // nothing is collected from members
  });

  it('admin handover warns that it cannot be undone', async () => {
    const { user } = await boot({}, { route: 'class', classApi: fakeApi({ overview: async () => [hosting(membership('admin'))], members: async () => members(2) }) });
    await user.click(await screen.findByRole('button', { name: /hand over administration/i }));
    const dlg = await screen.findByRole('dialog', { name: /hand over administration/i });
    expect(within(dlg).getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(within(dlg).getByText(/stops being able to administer or host it/i)).toBeInTheDocument();
  });
});

describe('Class page: member', () => {
  const memberOverview = (sync: SyncStatus): ClassOverview => ({ membership: membership('member'), host: null, sync });
  const live: SyncStatus = { state: 'live', last_sync_at: NOW, last_revision: 2, host: '192.168.1.20:47800' };

  it('shows the received rules with their provenance and what the admin can and cannot see', async () => {
    await boot({}, { route: 'class', classApi: fakeApi({ overview: async () => [memberOverview(live)] }) });
    expect(await screen.findByText(/revision 2, received/i)).toBeInTheDocument();
    expect(screen.getByText('TikTok')).toBeInTheDocument();
    expect(screen.getByText('20 min per day')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Read 30 pages')).toBeInTheDocument();
    expect(screen.getByText(/does not allow personal limits/i)).toBeInTheDocument();
    expect(screen.getByText(/never leave this computer/i)).toBeInTheDocument();
    expect(screen.getByText(/depends on your browser extension/i)).toBeInTheDocument();
  });

  it('tells the truth when the host is unreachable: last policy stays, study tools unaffected', async () => {
    const offline: SyncStatus = { state: 'offline', reason: 'could not reach the class host at 192.168.1.20:47800', last_sync_at: NOW - 600_000, last_revision: 2, host: null };
    await boot({}, { route: 'class', classApi: fakeApi({ overview: async () => [memberOverview(offline)] }) });
    expect((await screen.findAllByText('Host unreachable')).length).toBeGreaterThan(0);
    expect(screen.getByText(/last received policy stays in force/i)).toBeInTheDocument();
    expect(screen.getByText(/last policy update 10 min ago \(revision 2\)/i)).toBeInTheDocument();
    expect(screen.getByText(/only arrive while the administrator’s computer is on/i)).toBeInTheDocument();
    expect(screen.queryByText('Live')).not.toBeInTheDocument(); // never claims live updates
  });

  it('sync now calls the API and reports the outcome', async () => {
    const syncNow = vi.fn(async () => 'Applied(3)');
    const { user } = await boot({}, { route: 'class', classApi: fakeApi({ overview: async () => [memberOverview(live)], syncNow }) });
    await user.click(await screen.findByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(syncNow).toHaveBeenCalledWith('c1'));
    expect(await screen.findByText(/received a newer policy/i)).toBeInTheDocument();
  });

  it('live status pushed from the native side updates the screen', async () => {
    let push: (id: string, s: SyncStatus) => void = () => undefined;
    await boot({}, { route: 'class', classApi: fakeApi({ overview: async () => [memberOverview(live)], onSync: async (cb) => { push = cb; return () => undefined; } }) });
    expect((await screen.findAllByText('Live')).length).toBeGreaterThan(0);
    await waitFor(() => expect(typeof push).toBe('function'));
    useEnv.getState().setSync('c1', { state: 'removed', last_sync_at: NOW, last_revision: 2, host: null });
    expect((await screen.findAllByText('Removed from class')).length).toBeGreaterThan(0);
  });
});

describe('remainingText', () => {
  it('never overstates how long an invite is valid', () => {
    expect(remainingText(10 * 60_000 + 9_000)).toBe('10 min');
    expect(remainingText(10 * 60_000)).toBe('10 min');
    expect(remainingText(60_000)).toBe('1 min');
    expect(remainingText(59_999)).toBe('less than a minute');
    expect(remainingText(0)).toBe('less than a minute');
  });
});

describe('describeSync', () => {
  it('never says Live unless a connection is open', () => {
    for (const st of ['idle', 'connecting'] as const) expect(describeSync({ state: st, last_sync_at: null, last_revision: 0, host: null }).label).not.toBe('Live');
    expect(describeSync(null).label).toBe('Not started');
    expect(describeSync({ state: 'rejected', reason: 'unsupported schema', last_sync_at: NOW, last_revision: 1, host: null }).detail).toMatch(/previous policy stays in force/);
  });
});

describe('toPayload', () => {
  const row = (o = {}) => ({ key: 'k', platform: 'instagram', mode: 'budget' as const, minutes: 30, start: '15:00', end: '20:00', ...o });
  it('builds each rule kind and rejects invalid input before the host sees it', () => {
    expect(toPayload([row()], [], true).payload?.limits[0]).toEqual({ platform: 'instagram', blocked: false, daily_minutes: 30, allowed_windows: [] });
    expect(toPayload([row({ mode: 'blocked' })], [], true).payload?.limits[0]).toEqual({ platform: 'instagram', blocked: true, daily_minutes: null, allowed_windows: [] });
    expect(toPayload([row({ mode: 'hours' })], [], true).payload?.limits[0]?.allowed_windows).toEqual([{ days: [], start_min: 900, end_min: 1200 }]);
    expect(toPayload([row({ minutes: 5000 })], [], true).error).toMatch(/0 and 1440/);
    expect(toPayload([row({ mode: 'hours', start: '20:00', end: '19:00' })], [], true).error).toMatch(/end after/);
    expect(toPayload([row(), row({ key: 'k2' })], [], true).error).toMatch(/twice/);
    expect(toPayload([], [{ key: 'g', id: 'g', title: 'x', hours: 999 }], true).error).toMatch(/exceed a week/);
    expect(toPayload([], [{ key: 'g', id: 'g', title: '  ', hours: 2 }], true).payload?.study_goals).toEqual([]);
  });
});
