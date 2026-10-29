// Real end-to-end check: Chromium + unpacked extension + the real Rust bridge (examples/bridge_dev).
// Run:  xvfb-run -a node tests-e2e/extension.e2e.mjs      (needs `npm run build:extension` and a built bridge_dev)
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const TOKEN = 'e2e-token-0123456789abcdef0123456789abcdef';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-ext-'));
const rulesPath = path.join(tmp, 'rules.json');
const rules = (selfReported) => ({
  revision: 1, day: new Date().toISOString().slice(0, 10), time_zone: 'UTC', reset_hour: 0,
  rules: [{ platform: 'lab', domains: ['localhost'], daily_limit_minutes: 1, blocked: false, self_reported_minutes: selfReported, allowed_windows: [], origin: 'personal' }],
});
fs.writeFileSync(rulesPath, JSON.stringify(rules(0)));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// 1. a tiny site to "browse"
const site = http.createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>lab site</title><h1>hello from the limited site</h1>'); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const sitePort = site.address().port;

// 2. the real bridge
const bin = path.join(root, 'target/debug/examples/bridge_dev');
const bridge = spawn(bin, [TOKEN, rulesPath, '47777'], { stdio: ['ignore', 'pipe', 'inherit'] });
let bridgeAddr = null; let lastUsage = '[]'; let lastSeen = 0;
bridge.stdout.on('data', (d) => {
  for (const line of String(d).split('\n')) {
    if (line.startsWith('ADDR ')) bridgeAddr = line.slice(5).trim();
    const m = /^USAGE (.*) LASTSEEN (\d+)$/.exec(line);
    if (m) { lastUsage = m[1]; lastSeen = Number(m[2]); }
  }
});
for (let i = 0; i < 50 && !bridgeAddr; i++) await new Promise((r) => setTimeout(r, 100));
if (!bridgeAddr) throw new Error('bridge did not start');


console.log('bridge at', bridgeAddr);

const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  executablePath: '/opt/pw-browsers/chromium', headless: false,
  args: ['--no-sandbox', `--disable-extensions-except=${path.join(root, 'extension/dist')}`, `--load-extension=${path.join(root, 'extension/dist')}`],
});
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker', { timeout: 15000 });
check('extension service worker started', !!sw);

// Messages go from the extension's own options page, exactly as they do for a real user.
const extId = new URL(sw.url()).host;
const opts = await ctx.newPage();
await opts.goto(`chrome-extension://${extId}/options.html`);
const send = (type, config) => opts.evaluate(([t, c]) => new Promise((res) => chrome.runtime.sendMessage({ type: t, config: c }, res)), [type, config]);

// wrong token is rejected and reported honestly
let st = await send('save-config', { base: bridgeAddr, token: 'wrong-token-wrong-token-wrong-token-1234' });
check('wrong token is reported, not silently accepted', st.status && st.status.ok === false && /token was rejected/i.test(st.status.message), st.status?.message);

// right token connects
st = await send('save-config', { base: bridgeAddr, token: TOKEN });
check('correct token connects and fetches rules', st.status?.ok === true && st.rules?.rules?.[0]?.platform === 'lab', st.status?.message);
await new Promise((r) => setTimeout(r, 800));
check('app side sees the extension as connected (last_seen > 0)', lastSeen > 0);

// browse the limited site and let time pass
const page = await ctx.newPage();
await page.goto(`http://localhost:${sitePort}/`);
await page.bringToFront();
for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 3000)); await send('tick'); }
await new Promise((r) => setTimeout(r, 1200));
const usage = JSON.parse(lastUsage);
const sec = usage.filter((u) => u.platform === 'lab').reduce((a, u) => a + u.seconds, 0);
check('measured foreground time reached the app (≈9-13 s)', sec >= 6 && sec <= 16 && usage[0]?.source === 'browser_extension', `${sec}s, source=${usage[0]?.source}`);
check('limit not reached yet, so the site is still reachable', (await page.title()) === 'lab site');

// a background tab must NOT accrue time
const other = await ctx.newPage();
await other.goto('about:blank');
await other.bringToFront();
const before = sec;
for (let i = 0; i < 2; i++) { await new Promise((r) => setTimeout(r, 3000)); await send('tick'); }
await new Promise((r) => setTimeout(r, 1200));
const after = JSON.parse(lastUsage).filter((u) => u.platform === 'lab').reduce((a, u) => a + u.seconds, 0);
check('time is not counted while another tab is in front', after - before <= 3, `delta ${after - before}s`);

// self-reported minutes push usage over the 1-minute budget -> the app reloads rules -> extension blocks
fs.writeFileSync(rulesPath, JSON.stringify({ ...rules(1), revision: 2 }));
await new Promise((r) => setTimeout(r, 1500));
await send('tick');
await new Promise((r) => setTimeout(r, 1200));
check('already-open tab was moved to the blocked page', /blocked\.html/.test(page.url()), page.url());
const p2 = await ctx.newPage();
await p2.goto(`http://localhost:${sitePort}/`).catch(() => undefined);
await new Promise((r) => setTimeout(r, 800));
check('a new navigation to the platform is redirected too', /blocked\.html/.test(p2.url()), p2.url());
const body = await p2.textContent('body').catch(() => '');
check('blocked page explains why in plain words', /used today’s time budget/.test(body ?? ''), (body ?? '').trim().slice(0, 80));

// unblock: rules relaxed -> access returns
fs.writeFileSync(rulesPath, JSON.stringify({ ...rules(0), revision: 3, rules: [{ ...rules(0).rules[0], daily_limit_minutes: 120 }] }));
await new Promise((r) => setTimeout(r, 1500));
await send('tick');
await new Promise((r) => setTimeout(r, 800));
const p3 = await ctx.newPage();
await p3.goto(`http://localhost:${sitePort}/`);
check('relaxing the rule lifts the block', (await p3.title()) === 'lab site');

// bridge going away must not break the extension
bridge.kill();
await new Promise((r) => setTimeout(r, 500));
const s2 = await send('tick');
check('app unavailable -> honest status, last rules kept', s2.status?.ok === false && /Can’t reach FOCUS OS/.test(s2.status.message), s2.status?.message);

await ctx.close(); site.close();
fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
