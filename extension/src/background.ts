/// <reference types="chrome" />
/**
 * FOCUS OS extension service worker.
 *  - every 30 s: observe the focused tab + idle state, credit measured foreground time
 *  - upload usage to the desktop app over 127.0.0.1 (bearer token), fetch current rules
 *  - block platforms whose rule says no, via declarativeNetRequest + redirecting open tabs
 * Nothing leaves the computer; the only network peer is the desktop app on loopback.
 */
import { chunkForUpload, decide, mergePending, observe, platformForUrl, redirectRuleId, type Credit, type Rules, type TrackerState } from './tracker';

interface Config {
  base: string; // http://127.0.0.1:47777
  token: string;
}
interface Local {
  config?: Config;
  rules?: Rules;
  state?: TrackerState;
  pending?: Credit[];
  /** measured seconds today per platform, by day key: { "2026-03-02": { youtube: 120 } } */
  today?: Record<string, Record<string, number>>;
  status?: { ok: boolean; at: number; message: string };
}

const ALARM = 'focus-tick';

async function get(): Promise<Local> {
  return (await chrome.storage.local.get(null)) as Local;
}
const set = (v: Partial<Local>) => chrome.storage.local.set(v);

function isLoopback(base: string): boolean {
  try {
    const u = new URL(base);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch {
    return false;
  }
}

async function bridge(cfg: Config, path: string, init?: RequestInit): Promise<Response> {
  if (!isLoopback(cfg.base)) throw new Error('The bridge address must be on this computer (127.0.0.1).');
  return fetch(cfg.base + path, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}`, ...(init?.headers ?? {}) } });
}

async function engagedPlatform(rules: Rules | undefined) {
  if (!rules) return { engaged: false, platform: null as string | null, tabId: undefined as number | undefined };
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const win = tab?.windowId !== undefined ? await chrome.windows.get(tab.windowId).catch(() => null) : null;
  const idle = await chrome.idle.queryState(60);
  const rule = tab?.url ? platformForUrl(tab.url, rules.rules) : null;
  return { engaged: !!rule && !!win?.focused && idle === 'active', platform: rule?.platform ?? null, tabId: tab?.id };
}

async function applyBlocking(rules: Rules, todaySec: Record<string, number>, now: number) {
  const blocked: { platform: string; domains: string[]; reason: string }[] = [];
  for (const r of rules.rules) {
    const d = decide(r, todaySec[r.platform] ?? 0, now, rules.time_zone);
    if (!d.allow) blocked.push({ platform: r.platform, domains: r.domains, reason: d.reason });
  }
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const add: chrome.declarativeNetRequest.Rule[] = blocked.map((b, i) => ({
    id: redirectRuleId(b.platform, i),
    priority: 1,
    action: { type: 'redirect' as chrome.declarativeNetRequest.RuleActionType, redirect: { extensionPath: `/blocked.html?p=${encodeURIComponent(b.platform)}&r=${b.reason}` } },
    condition: { requestDomains: b.domains, resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType] },
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: add });
  // Rules only affect new navigations; move tabs that are already open on a blocked platform.
  if (blocked.length) {
    for (const tab of await chrome.tabs.query({})) {
      const rule = tab.url ? platformForUrl(tab.url, rules.rules) : null;
      const hit = rule && blocked.find((b) => b.platform === rule.platform);
      if (hit && tab.id !== undefined) await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL(`/blocked.html?p=${encodeURIComponent(hit.platform)}&r=${hit.reason}`) });
    }
  }
}

async function tick() {
  const now = Date.now();
  const l = await get();
  if (!l.config) return;
  let rules = l.rules;
  let status: Local['status'];
  // 1. rules from the app
  try {
    const r = await bridge(l.config, '/v1/rules');
    if (r.status === 401) throw new Error('The token was rejected. Copy it again from FOCUS OS → Limits.');
    if (!r.ok) throw new Error(`The app answered ${r.status}.`);
    rules = (await r.json()) as Rules;
    status = { ok: true, at: now, message: `Connected. Rules revision ${rules.revision}.` };
  } catch (e) {
    status = { ok: false, at: now, message: `Can’t reach FOCUS OS: ${(e as Error).message.replace(/\.$/, '')}. Using the last known rules.` };
  }
  // 2. observe + credit
  const dayRules = { timeZone: rules?.time_zone ?? 'UTC', resetHour: rules?.reset_hour ?? 0 };
  const eng = await engagedPlatform(rules);
  const { state, credit } = observe(l.state ?? { last: null }, { at: now, engaged: eng.engaged, platform: eng.platform }, dayRules);
  const today = { ...(l.today ?? {}) };
  if (credit) {
    today[credit.day] = { ...(today[credit.day] ?? {}), [credit.platform]: (today[credit.day]?.[credit.platform] ?? 0) + credit.seconds };
  }
  // keep two days of local counters
  for (const k of Object.keys(today).sort().slice(0, -2)) delete today[k];
  let pending = mergePending(l.pending ?? [], credit);
  // 3. upload; keep anything that fails
  const failed: Credit[] = [];
  for (const c of chunkForUpload(pending)) {
    try {
      const r = await bridge(l.config, '/v1/usage', { method: 'POST', body: JSON.stringify({ day: c.day, platform: c.platform, seconds: c.seconds }) });
      if (!r.ok && r.status !== 400) failed.push(c); // 400 = invalid report: drop, retrying cannot help
    } catch {
      failed.push(c);
    }
  }
  pending = failed.length ? chunkMerge(failed) : [];
  await set({ rules, state, today, pending, status });
  // 4. enforce
  if (rules) {
    const day = rules.day;
    const cur = today[Object.keys(today).sort().pop() ?? day] ?? {};
    await applyBlocking(rules, cur, now).catch(() => undefined);
  }
}

const chunkMerge = (c: Credit[]) => c.reduce<Credit[]>((acc, x) => mergePending(acc, x), []);

chrome.runtime.onInstalled.addListener(() => void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }));
chrome.runtime.onStartup.addListener(() => void chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) void tick(); });
chrome.tabs.onActivated.addListener(() => void tick());
chrome.windows.onFocusChanged.addListener(() => void tick());
chrome.runtime.onMessage.addListener((msg: { type: string; config?: Config }, _s, reply) => {
  if (msg.type === 'save-config' && msg.config) {
    void set({ config: msg.config, state: { last: null } }).then(() => tick()).then(async () => reply(await get()));
    return true;
  }
  if (msg.type === 'tick') { void tick().then(async () => reply(await get())); return true; }
  return false;
});
