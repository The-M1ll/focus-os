/// <reference types="chrome" />
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function render() {
  const l = (await chrome.storage.local.get(null)) as { config?: { base: string; token: string }; status?: { ok: boolean; message: string; at: number }; today?: Record<string, Record<string, number>>; rules?: { revision: number; rules: { platform: string }[] } };
  if (l.config) { $<HTMLInputElement>('base').value = l.config.base; }
  const s = $('status');
  if (l.status) {
    s.textContent = l.status.message;
    s.dataset.ok = String(l.status.ok);
  } else s.textContent = 'Not connected yet.';
  const days = Object.keys(l.today ?? {}).sort();
  const cur = (l.today ?? {})[days[days.length - 1] ?? ''] ?? {};
  $('usage').textContent = Object.keys(cur).length ? Object.entries(cur).map(([p, sec]) => `${p}: ${Math.round(sec / 60)} min`).join(' · ') : 'Nothing measured yet today.';
}

$('save').addEventListener('click', async () => {
  const base = $<HTMLInputElement>('base').value.trim().replace(/\/$/, '');
  const token = $<HTMLInputElement>('token').value.trim();
  const err = $('error');
  err.textContent = '';
  try {
    const u = new URL(base);
    if (u.protocol !== 'http:' || (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost')) throw new Error('The address must look like http://127.0.0.1:47777 (this computer only).');
  } catch (e) {
    err.textContent = (e as Error).message;
    return;
  }
  if (token.length < 32) { err.textContent = 'Paste the full token from FOCUS OS → Limits.'; return; }
  await chrome.runtime.sendMessage({ type: 'save-config', config: { base, token } });
  $<HTMLInputElement>('token').value = '';
  await render();
});
$('refresh').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'tick' }); await render(); });
void render();
