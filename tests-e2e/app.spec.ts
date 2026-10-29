import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const today = () => new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function seed(page: Page, theme: 'dark' | 'light' = 'dark') {
  await page.goto('/');
  await page.evaluate(([t, d0, d1, d2]) => {
    const put = (col: string, docs: Array<{ id: string }>) => {
      const o: Record<string, { json: string; updated_at: number }> = {};
      for (const d of docs) o[d.id] = { json: JSON.stringify(d), updated_at: 1 };
      localStorage.setItem('focusos:v1:' + col, JSON.stringify(o));
    };
    put('settings', [{ id: 'main', onboarded: true, displayName: 'Aziza', timeZone: 'UTC', resetHour: 0, theme: t }]);
    put('subjects', [{ id: 'math', name: 'Mathematics', color: '#cfef5b', archived: false, createdAt: 1 }, { id: 'phys', name: 'Physics', color: '#8ab4f8', archived: false, createdAt: 2 }]);
    put('topics', [{ id: 'tp1', subjectId: 'math', name: 'Quadratics', archived: false, createdAt: 1 }]);
    put('tasks', [
      { id: 't1', title: 'Algebra worksheet 4', subjectId: 'math', kind: 'homework', due: d0, estimateMin: 40, actualMin: 55, priority: 3, status: 'todo', createdAt: 1 },
      { id: 't2', title: 'Read chapter 7', subjectId: 'phys', kind: 'homework', due: d1, estimateMin: 30, actualMin: 0, priority: 2, status: 'todo', createdAt: 2 },
    ]);
    put('exams', [{ id: 'e1', subjectId: 'phys', title: 'Physics midterm', date: d2, topicIds: [], createdAt: 1 }]);
    put('notes', [{ id: 'n1', subjectId: 'math', topicId: 'tp1', title: 'Completing the square', body: '# Idea\n\nRewrite **ax² + bx + c**.\n\n- Halve b\n- [x] Example', createdAt: 1, updatedAt: Date.now() }]);
    put('cards', Array.from({ length: 4 }, (_, i) => ({ id: 'c' + i, subjectId: 'math', front: `Question ${i}`, back: `Answer ${i}`, source: 'manual', createdAt: i + 1, srs: { state: i < 3 ? 'review' : 'new', ease: 2.5, interval: 5, reps: 1, lapses: 0, due: d0 } })));
    put('quizzes', [{ id: 'q1', subjectId: 'math', title: 'Quadratics check', createdAt: 1, updatedAt: 2, questions: [{ type: 'mc', id: 'a1', prompt: 'Vertex of y=(x−2)²+3?', choices: ['(2,3)', '(−2,3)'], answerIndex: 0 }] }]);
    put('limits', [{ id: 'l1', platform: 'instagram', dailyMinutes: 30, days: [0, 1, 2, 3, 4, 5, 6], allowedStart: null, allowedEnd: null, warnAtPct: 80, enabled: true, createdAt: 1 }]);
    put('manual_usage', [{ id: 'm1', day: d0, platform: 'instagram', minutes: 24, at: 1 }]);
  }, [theme, today(), day(2), day(6)] as const);
  await page.reload();
  await page.getByRole('timer').waitFor(); // the workspace (and its keyboard shortcuts) is mounted
}

async function axe(page: Page) {
  await page.addScriptTag({ content: AXE_SOURCE });
  // Mid-fade text is semi-transparent and fails contrast on slow machines; audit the settled page.
  await page.evaluate(async () => {
    for (let i = 0; i < 50 && document.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity); i++) await new Promise((r) => setTimeout(r, 100));
  });
  return page.evaluate(async () => {
    // @ts-expect-error injected global
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice'] }, rules: { region: { enabled: false } } });
    return r.violations.map((v: { id: string; impact: string; nodes: { html: string; target: string[]; any?: { message: string }[] }[] }) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' :: ' + (n.any?.[0]?.message ?? '')) }));
  });
}

test.describe('first run', () => {
  test('intro → setup → workspace, and never again', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('dialog', { name: /welcome to focus os/i })).toBeVisible();
    await page.getByRole('button', { name: /begin/i }).click();
    await page.getByLabel(/what should we call you/i).fill('Bek');
    await page.getByRole('button', { name: /enter focus os/i }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Bek');
    await page.reload();
    await expect(page.getByRole('dialog', { name: /welcome/i })).toHaveCount(0);
    await expect(page.getByRole('timer')).toBeVisible();
  });
});

test.describe('workflows', () => {
  test('focus timer: start, pause, resume, end; survives reload as interrupted-or-running, never lost', async ({ page }) => {
    await seed(page);
    await page.getByRole('button', { name: /start 25 min/i }).click();
    await expect(page.getByRole('button', { name: /pause/i })).toBeVisible();
    await page.waitForTimeout(2200);
    const t = await page.getByRole('timer').textContent();
    expect(t).not.toBe('25:00');
    await page.getByRole('button', { name: /pause/i }).click();
    await expect(page.getByText('Paused')).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: /resume/i })).toBeVisible(); // state survived the restart
    await page.getByRole('button', { name: /end & log/i }).click();
    await expect(page.getByRole('button', { name: /start 25 min/i })).toBeVisible();
  });

  test('keyboard navigation and command palette', async ({ page }) => {
    await seed(page);
    await page.keyboard.press('2');
    await expect(page.getByRole('heading', { level: 1, name: /mathematics|physics/i })).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByLabel(/search commands, notes and cards/i).fill('square');
    await expect(page.getByRole('option', { name: /completing the square/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeVisible();
  });

  test('plan: add a task and see it ranked on Today with a reason', async ({ page }) => {
    await seed(page);
    await page.keyboard.press('4');
    await page.getByRole('button', { name: /new task/i }).click();
    const dlg = page.getByRole('dialog', { name: 'New task' });
    await dlg.getByLabel('Task').fill('Chemistry lab report');
    await dlg.getByLabel('Due date').fill(today());
    await dlg.getByRole('button', { name: 'Add task' }).click();
    await expect(page.getByText('Chemistry lab report')).toBeVisible();
    await page.keyboard.press('1');
    const agenda = page.getByRole('complementary', { name: /today.s agenda/i });
    await expect(agenda.getByText('Chemistry lab report')).toBeVisible();
    await expect(agenda.getByText(/due today/i).first()).toBeVisible();
  });

  test('note autosave persists across a reload', async ({ page }) => {
    await seed(page);
    await page.keyboard.press('2');
    await page.getByRole('button', { name: /^Completing the square/ }).click();
    const body = page.getByLabel('Note body');
    await body.click();
    await body.press('Control+End');
    await body.pressSequentially('\nAdded in e2e');
    await expect(page.getByText(/^Saved \d/)).toBeVisible({ timeout: 5000 });
    await page.reload();
    await page.keyboard.press('2');
    await page.getByRole('button', { name: /^Completing the square/ }).click();
    await expect(page.getByLabel('Note body')).toHaveValue(/Added in e2e/);
  });

  test('flashcard review with the keyboard', async ({ page }) => {
    await seed(page);
    await page.keyboard.press('3');
    await page.getByRole('button', { name: /start review/i }).click();
    await page.keyboard.press(' ');
    await expect(page.getByLabel('Answer')).toBeVisible();
    await page.keyboard.press('3');
    await expect(page.getByText(/of \d+ done/)).toBeVisible();
  });

  test('limits tells the truth in the browser preview', async ({ page }) => {
    await seed(page);
    await page.keyboard.press('5');
    await expect(page.getByText('Desktop app only')).toBeVisible();
    await expect(page.getByText(/configured, but not enforced/i).first()).toBeVisible();
    await expect(page.getByText(/self-reported/i).first()).toBeVisible();
    await expect(page.getByText(/never measured automatically/i)).toBeVisible();
  });
});

test.describe('layout', () => {
  for (const [w, h] of [[1280, 820], [900, 640], [760, 560]] as const) {
    test(`no horizontal overflow at ${w}x${h} on every screen`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: h });
      await seed(page);
      for (const r of ['today', 'library', 'review', 'plan', 'limits', 'apps', 'class', 'settings']) {
        await page.goto(`/#/${r}`);
        await page.waitForTimeout(150);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(over, `${r} at ${w}px overflows by ${over}px`).toBeLessThanOrEqual(1);
      }
    });
  }
});

test.describe('accessibility (axe-core, real rendering incl. colour contrast)', () => {
  test('harness self-check: the audit really detects contrast and labelling failures', async ({ page }) => {
    await seed(page);
    await page.evaluate(() => {
      const bad = document.createElement('div');
      bad.innerHTML = '<p style="color:#777;background:#888;padding:8px">low contrast text</p><img src="x.png"><button></button><input>';
      document.querySelector('main')!.appendChild(bad);
    });
    const ids = (await axe(page)).map((v: { id: string }) => v.id);
    for (const want of ['color-contrast', 'image-alt', 'button-name', 'label']) expect(ids, `axe should flag ${want}`).toContain(want);
  });

  for (const theme of ['dark', 'light'] as const) {
    for (const r of ['today', 'library', 'review', 'plan', 'limits', 'apps', 'class', 'settings']) {
      test(`${r} — ${theme}`, async ({ page }) => {
        await seed(page, theme);
        await page.goto(`/#/${r}`);
        await page.waitForTimeout(300);
        const v = await axe(page);
        expect(v, JSON.stringify(v, null, 1)).toEqual([]);
      });
    }
  }

  test('dialogs trap focus and Escape returns focus to the opener', async ({ page }) => {
    await seed(page);
    await page.keyboard.press('4');
    const opener = page.getByRole('button', { name: /new task/i });
    await opener.focus();
    await opener.press('Enter');
    const dlg = page.getByRole('dialog', { name: 'New task' });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByLabel('Task')).toBeFocused();
    for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
    expect(await dlg.evaluate((d) => d.contains(document.activeElement))).toBe(true); // focus never leaves the modal
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('sticky masthead never covers keyboard focus or anchored content (scroll-padding)', async ({ page }) => {
    await seed(page);
    const { pad, head } = await page.evaluate(() => ({ pad: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop), head: document.querySelector('.masthead')!.getBoundingClientRect().height }));
    expect(pad).toBeGreaterThanOrEqual(head); // anything scrolled into view lands below the header
    // Tab through a long page; every focused control must end up below the sticky header.
    await page.goto('/#/settings');
    await page.getByRole('heading', { level: 1, name: 'Settings' }).waitFor();
    let checked = 0;
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press('Tab');
      const r = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        if (!el || el === document.body || el.closest('.masthead') || el.classList.contains('skip-link')) return null; // the skip link intentionally overlays the header
        return { top: el.getBoundingClientRect().top, header: document.querySelector('.masthead')!.getBoundingClientRect().bottom, name: el.getAttribute('aria-label') ?? el.textContent?.slice(0, 20) ?? el.tagName };
      });
      if (r) { checked++; expect(r.top, `focused “${r.name}” is under the header`).toBeGreaterThanOrEqual(r.header - 1); }
    }
    expect(checked).toBeGreaterThan(10);
  });

  test('reduced motion setting removes animations', async ({ page }) => {
    await seed(page);
    const dur = await page.evaluate(() => getComputedStyle(document.querySelector('.dial-arc')!).transitionDuration);
    expect(parseFloat(dur)).toBeLessThan(0.05);
  });

  test.describe('ambient effects (sparkles and 3D shapes)', () => {
    test('are decorative: hidden from assistive tech, never intercept the pointer, and do not overflow', async ({ page }) => {
      await seed(page);
      const info = await page.evaluate(() => {
        const a = document.querySelector('.ambient') as HTMLElement;
        const g = document.querySelector('.gyro') as HTMLElement;
        return { ariaHidden: a.getAttribute('aria-hidden'), pe: getComputedStyle(a).pointerEvents, sparks: a.querySelectorAll('.spark').length, gyroHidden: g.getAttribute('aria-hidden'), over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      expect(info).toMatchObject({ ariaHidden: 'true', pe: 'none', gyroHidden: 'true' });
      expect(info.sparks).toBeGreaterThan(10);
      expect(info.over).toBeLessThanOrEqual(1);
      // Clicking where a sparkle sits still reaches the page: the start button works through the layer.
      await page.getByRole('button', { name: /start 25 min/i }).click();
      await expect(page.getByRole('button', { name: /pause/i })).toBeVisible();
    });

    test('can be switched off in Settings and stay off', async ({ page }) => {
      await seed(page);
      await page.keyboard.press('Control+k');
      await page.getByLabel(/search commands, notes and cards/i).fill('settings');
      await page.keyboard.press('Enter');
      await page.getByRole('switch', { name: /ambient effects/i }).uncheck();
      await expect(page.locator('.ambient')).toHaveCount(0);
      await page.reload();
      await page.getByRole('timer').waitFor();
      await expect(page.locator('.ambient')).toHaveCount(0);
      await expect(page.locator('.gyro')).toHaveCount(0);
    });

    test('are still when animation is reduced', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await seed(page);
      const dur = await page.evaluate(() => getComputedStyle(document.querySelector('.spark')!).animationDuration);
      expect(parseFloat(dur)).toBeLessThan(0.05);
      const spin = await page.evaluate(() => getComputedStyle(document.querySelector('.gyro-body')!).animationDuration);
      expect(parseFloat(spin)).toBeLessThan(0.05);
    });
  });
});
