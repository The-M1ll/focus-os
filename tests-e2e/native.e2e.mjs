// Native end-to-end: the REAL desktop app (WebKitGTK webview + Rust + SQLite), driven through its real UI via
// tauri-driver/WebKitWebDriver, plus an INDEPENDENT second device written in Node from the protocol spec.
// Run:  xvfb-run -a node tests-e2e/native.e2e.mjs   (needs: npm run build; cargo build -p focus-os --features custom-protocol; tauri-driver)
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const BIN = path.join(root, 'target/debug/focus-os');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-native-'));
const dataDir = path.join(home, 'data', 'app.focusos.desktop');
const env = { ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'data'), WEBKIT_DISABLE_COMPOSITING_MODE: '1', WEBKIT_DISABLE_DMABUF_RENDERER: '1', GDK_BACKEND: 'x11' };
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny W3C WebDriver client -------------------------------------------------
const driver = spawn('tauri-driver', ['--port', '4444'], { env, stdio: 'ignore' });
await sleep(1500);
const wd = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:4444${p}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value?.error) throw new Error(`${j.value.error}: ${j.value.message}`);
  return j.value;
};
let sid = null;
const E = 'element-6066-11e4-a52e-4f735466cecf';
async function start() {
  const v = await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: BIN } } } });
  sid = v.sessionId;
}
const find = async (using, value) => (await wd('POST', `/session/${sid}/elements`, { using, value })).map((e) => e[E]);
const x = (s) => find('xpath', s);
async function waitFor(fn, what, ms = 15000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(200); }
  throw new Error('timed out waiting for ' + what);
}
const click = async (id) => { await exec('arguments[0].scrollIntoView({block:"center"})', [{ [E]: id }]).catch(() => undefined); return wd('POST', `/session/${sid}/element/${id}/click`, {}); };
const type = (id, text) => wd('POST', `/session/${sid}/element/${id}/value`, { text });
const exec = (script, args = []) => wd('POST', `/session/${sid}/execute/sync`, { script, args });
const btn = async (text, ms) => (await waitFor(async () => (await x(`//button[normalize-space(.)='${text}' or contains(normalize-space(.),'${text}')]`))[0], `button "${text}"`, ms));
const byLabel = async (label) => waitFor(async () => (await x(`//label[normalize-space(.)='${label}']`)).length ? exec(`const l=[...document.querySelectorAll('label')].find(l=>l.textContent.trim()==='${label}'); return l && l.htmlFor ? document.getElementById(l.htmlFor) : null`).then((el) => el?.[E]) : null, `field "${label}"`);
const go = (route) => exec(`location.hash='#/${route}'`);
// innerText applies CSS text-transform (pills are uppercase), so compare case-insensitively.
const bodyText = () => exec('return document.body.innerText').then((t) => t);
const has = async (needle) => (await bodyText()).toLowerCase().includes(needle.toLowerCase());
const db = (file, sql) => JSON.parse(execFileSync('python3', ['-c', `import sqlite3,json,sys;c=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute(sys.argv[2]).fetchall()))`, path.join(dataDir, file), sql]).toString());

try {
  // ---- 1. first run, through the real UI -------------------------------------
  await start();
  await click(await btn('Skip'));
  const timer = await waitFor(async () => (await find('css selector', '[role=timer]'))[0], 'the workspace');
  check('app starts, onboarding can be skipped, workspace renders in the native webview', !!timer);
  check('runs on native SQLite (no browser-preview banner)', !(await has('Browser preview')));
  await sleep(600);
  const s = db('personal.db', "select json from documents where collection='settings'");
  check('settings persisted to the native personal.db', s.length === 1 && JSON.parse(s[0][0]).onboarded === true);
  check('db files are owner-only (0600)', ['personal.db', 'classroom.db', 'bridge.token'].every((f) => (fs.statSync(path.join(dataDir, f)).mode & 0o077) === 0));

  // ---- 2. timer persisted natively --------------------------------------------
  await click(await btn('Start 25 min'));
  await waitFor(async () => (await x("//button[contains(.,'Pause')]")).length, 'running timer');
  await sleep(2500);
  const shown = await exec("return document.querySelector('[role=timer]').textContent");
  check('timer counts down in the native app', shown !== '25:00', shown);
  const t = db('personal.db', "select json from documents where collection='timer'");
  check('running timer is persisted to SQLite (restart recovery has data)', t.length === 1 && JSON.parse(t[0][0]).status === 'running');
  await click(await btn('Pause'));

  // ---- 3. a task through the real UI -------------------------------------------
  await go('plan');
  await click(await btn('New task'));
  await type(await byLabel('Task'), 'Native e2e homework');
  await click(await waitFor(async () => (await x("//dialog//button[normalize-space(.)='Add task']"))[0], 'Add task'));
  await waitFor(async () => db('personal.db', "select 1 from documents where collection='tasks'").length === 1, 'task row');
  check('task created in the UI lands in native SQLite', JSON.parse(db('personal.db', "select json from documents where collection='tasks'")[0][0]).title === 'Native e2e homework');

  // ---- 4. create a class (real Rust host) --------------------------------------
  await go('class');
  await click(await btn('Create a class'));
  await type(await byLabel('Class name'), 'Native 10B');
  await type(await byLabel('Your name (shown to members)'), 'Ms. Native');
  await type(await byLabel('Administrator passphrase'), 'native e2e passphrase');
  await type(await byLabel('Repeat passphrase'), 'native e2e passphrase');
  await click(await btn('Create and start hosting'));
  await waitFor(async () => (await has('Hosting')) && /\d+\.\d+\.\d+\.\d+:\d+/.test(await bodyText()), 'hosting status', 30000);
  const cls = db('classroom.db', 'select id,name,status,key_id,signing_key_sealed from classes');
  check('class stored; signing key is sealed (not plaintext) with Argon2id params', cls.length === 1 && cls[0][2] === 'active' && /"m_kib":65536/.test(cls[0][4]) && !/BEGIN|secret/i.test(cls[0][4]));
  const addr = (await bodyText()).match(/(\d+\.\d+\.\d+\.\d+:\d+)/)[1];
  const classId = cls[0][0];
  const hello = await (await fetch(`http://${addr}/v1/hello`)).json();
  check('host service answers on its LAN address and identifies the class', hello.class_id === classId && hello.protocol === 1, addr);
  check('host is NOT listening on loopback/all interfaces (single chosen interface)', await fetch(`http://127.0.0.1:${addr.split(':')[1]}/v1/hello`).then(() => false, () => true));

  // ---- 5. invite through the UI; join as an independent device written in Node -----
  await click(await btn('Create invite'));
  const code = await waitFor(async () => exec(`const c=document.querySelector('code[aria-label="Join code"]'); return c ? c.textContent.trim() : null`), 'join code');
  const jp = JSON.parse(Buffer.from(code.replace('focusos://join/', ''), 'base64url').toString());
  check('join code carries class identity, address, expiry (<= 15 min) and a 128-bit secret', jp.class_id === classId && jp.addrs[0] === addr && jp.expires_at - Date.now() <= 15 * 60_000 && Buffer.from(jp.token, 'base64url').length === 16);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const devPub = raw.toString('base64url');
  const devId = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  const sign = (m) => crypto.sign(null, Buffer.from(m), privateKey).toString('base64url');
  const hmac = (m) => crypto.createHmac('sha256', Buffer.from(jp.token, 'base64url')).update(m).digest('base64url');
  const nonce = crypto.randomBytes(16).toString('hex'); const ts = Date.now();
  const join = { pairing_id: jp.pairing_id, device_pub: devPub, display_name: 'Aziza (node device)', ts, nonce };
  const msg = `focus-join-v1\n${classId}\n${join.pairing_id}\n${devPub}\n${join.display_name}\n${ts}\n${nonce}`;
  const jr = await fetch(`http://${addr}/v1/join`, { method: 'POST', body: JSON.stringify({ ...join, proof: hmac(msg), device_sig: sign(msg) }) });
  const jres = await jr.json();
  check('independent (Node) device joins using only the documented protocol', jr.status === 200 && jres.role === 'member', JSON.stringify(jres).slice(0, 80));
  check('host proved knowledge of the pairing secret (HMAC verifies in Node)', jres.host_proof === hmac(`focus-host-v1\n${classId}\n${devPub}\n${nonce}\n${jres.member_id}`));
  check('host returned the class key that was in the code (pinned identity)', jres.class_pub === jp.class_pub);
  const replay = await fetch(`http://${addr}/v1/join`, { method: 'POST', body: JSON.stringify({ ...join, proof: hmac(msg), device_sig: sign(msg) }) });
  check('replaying the same join request is refused', replay.status === 403);
  const bad = await fetch(`http://${addr}/v1/join`, { method: 'POST', body: JSON.stringify({ ...join, nonce: 'x'.repeat(8), proof: 'AAAA', device_sig: 'AAAA' }) });
  check('a join with a wrong proof is refused', bad.status === 403);

  const signedGet = async (p, method = 'GET', body = '') => {
    const n = crypto.randomBytes(16).toString('hex'); const t2 = Date.now();
    const sig = sign(`focus-req-v1\n${classId}\n${method}\n${p}\n${t2}\n${n}\n${crypto.createHash('sha256').update(body).digest('hex')}`);
    return fetch(`http://${addr}${p}`, { method, body: body || undefined, headers: { 'x-focus-device': devId, 'x-focus-class': classId, 'x-focus-ts': String(t2), 'x-focus-nonce': n, 'x-focus-sig': sig } });
  };
  check('node device can fetch policy (none published yet)', (await (await signedGet('/v1/policy')).json()).policy === null);
  const forbidden = await signedGet('/v1/admin/members');
  check('a member device cannot read the roster (403)', forbidden.status === 403);
  const evil = await signedGet('/v1/admin/policy', 'POST', JSON.stringify({ payload: { limits: [], study_goals: [], allow_personal_limits: true } }));
  check('a member device cannot publish policy (403)', evil.status === 403);

  // ---- 6. publish through the admin UI; verify the signature in Node ---------------
  await waitFor(async () => has('Aziza (node device)'), 'member appears in the admin UI');
  check('joined device appears in the admin member list', true);
  const addBtn = await btn('Add website rule');
  await click(addBtn);
  const pubBtn = await btn('Publish revision 1');
  await click(pubBtn);
  await waitFor(async () => db('classroom.db', 'select revision from policy_revisions').length === 1, 'revision stored', 8000);
  const pol = (await (await signedGet('/v1/policy')).json()).policy;
  const classPub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jp.class_pub }, format: 'jwk' });
  const sigOk = crypto.verify(null, Buffer.from(pol.envelope), classPub, Buffer.from(pol.signature, 'base64url'));
  check('policy signature made by Rust verifies with Node crypto against the pinned key', sigOk);
  const env = JSON.parse(pol.envelope);
  check('policy envelope carries class id, schema v1, revision 1, publisher key id', env.class_id === classId && env.schema_version === 1 && env.revision === 1 && env.publisher_key_id === pol.key_id);
  const tampered = pol.envelope.replace('"revision":1', '"revision":9');
  check('a tampered envelope fails verification', !crypto.verify(null, Buffer.from(tampered), classPub, Buffer.from(pol.signature, 'base64url')));
  const ack = await signedGet('/v1/ack', 'POST', JSON.stringify({ revision: 1 }));
  check('device acknowledges the revision', ack.status === 204);
  await waitFor(async () => has('Has revision 1'), 'ack shown in admin UI');
  check('admin UI shows the real acknowledgement from the device', true);

  // ---- 7. restart: everything persisted -----------------------------------------
  await wd('DELETE', `/session/${sid}`);
  await sleep(800);
  await start();
  const t2 = await waitFor(async () => (await find('css selector', '[role=timer]'))[0], 'workspace after restart');
  check('after restart the app opens straight to the workspace (no onboarding)', !!t2 && !(await has('Begin')));
  await go('plan');
  await waitFor(async () => has('Native e2e homework'), 'task after restart');
  check('task survived the restart', true);
  await go('class');
  await waitFor(async () => has('Native 10B'), 'class after restart');
  const txt = await bodyText();
  check('class survived; host is NOT silently running after restart (needs passphrase)', txt.toLowerCase().includes('not hosting') && txt.toLowerCase().includes('unlock and start hosting'));
  check('the policy and members were persisted by the host', db('classroom.db', 'select count(*) from members')[0][0] === 2 && db('classroom.db', 'select count(*) from policy_revisions')[0][0] === 1);
  await go('today');
  await waitFor(async () => (await has('Session interrupted')) || (await has('Resume')), 'recovered timer');
  check('the paused timer is still there after restart', true);

  // ---- 7. Apps: a real program is listed, warned about and then really closed ---------------------------------------
  const victim = spawn('sleep', ['600'], { stdio: 'ignore' });
  let victimExit = null;
  victim.on('exit', (code, signal) => { victimExit = signal ?? code; });
  await go('apps');
  await waitFor(async () => (await has('Apps on this computer')) && (await has('Watching this computer')), 'the Apps screen reporting the monitor');
  check('Apps screen says the desktop monitor is watching (not the browser-preview wording)', !(await has('Desktop app only')));
  await waitFor(async () => (await x("//ul[@aria-label='Apps found on this computer']//span[normalize-space(.)='Sleep']")).length, 'the running "sleep" program in the list', 20000);
  check('a program that is really running on this computer appears in the app list', true);
  check('protected programs (shell, init, FOCUS OS) are never offered', !(await exec("return [...document.querySelectorAll('[aria-label=\"Apps found on this computer\"] .row-title')].map(e=>e.textContent.toLowerCase()).some(n=>['bash','systemd','focus-os','focus os','sh','init'].includes(n))")));
  await click(await waitFor(async () => (await x("//button[@aria-label='Set a limit for Sleep']"))[0], 'Set limit for Sleep'));
  const minutes = await byLabel('Minutes per day');
  await exec('arguments[0].select()', [{ [E]: minutes }]);
  await type(minutes, '0');
  await click(await btn('Save rule'));
  await waitFor(async () => db('personal.db', "select json from documents where collection='limits'").some((r) => JSON.parse(r[0]).platform === 'app.sleep'), 'the app rule in SQLite');
  check('an app rule created in the UI lands in native SQLite as app.<name>', true);
  await waitFor(async () => (await has('Sleep will close in')) || (await has('time is up')), 'the closing warning', 40000);
  check('the student is warned before anything is closed', victimExit === null);
  await waitFor(async () => victimExit !== null, 'the program to be closed by FOCUS OS', 120000);
  check('after the grace period FOCUS OS really ended the program', victimExit !== null, String(victimExit));
  const usage = db('personal.db', "select app, seconds from app_usage where app='sleep'");
  check('open time was measured and stored on this computer (app_usage)', usage.length === 1 && usage[0][1] >= 10, JSON.stringify(usage));
  if (victimExit === null) victim.kill();
} catch (e) {
  console.log('ERROR', e.stack ?? e);
  results.push(false);
} finally {
  try { if (sid) await wd('DELETE', `/session/${sid}`); } catch { /* ignore */ }
  driver.kill();
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} checks passed`);
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* the app may still be flushing on exit; the temp dir is disposable */ }
  process.exit(ok === results.length ? 0 : 1);
}
