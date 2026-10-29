import { defineConfig } from '@playwright/test';

// Browser-preview e2e: the real UI in real Chromium against the BrowserBackend.
// (The native SQLite path is covered by Rust tests + the Tauri IPC tests.)
export default defineConfig({
  testDir: './tests-e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium', args: ['--no-sandbox'] },
    reducedMotion: 'reduce',
  },
  webServer: { command: 'npx vite preview --port 4173 --strictPort --host 127.0.0.1', url: 'http://127.0.0.1:4173', reuseExistingServer: true, timeout: 60_000 },
});
