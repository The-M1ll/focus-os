import { screen, waitFor, within, act } from '@testing-library/react';
import { boot, card, dayOffset, subject, task, TODAY } from '../../test-utils';
import { useData } from '../../data/store';
import { useTimer } from '../../state/timer';
import { useUI } from '../ui-state';

const readDocs = async (be: { getAll: (c: string) => Promise<{ id: string; json: string }[]> }, col: string) => (await be.getAll(col)).map((d) => JSON.parse(d.json));

describe('first run', () => {
  it('shows the intro, lets the student skip, and never shows it again', async () => {
    const { user, be, unmount } = await boot({}, { onboarded: false });
    expect(await screen.findByRole('dialog', { name: /welcome to focus os/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /welcome/i })).not.toBeInTheDocument());
    expect((await readDocs(be, 'settings'))[0].onboarded).toBe(true);
    unmount();
    // returning user goes straight to the workspace
    const again = await boot({ settings: (await readDocs(be, 'settings')) }, { onboarded: true });
    expect(await again.findByRole('heading', { level: 1, name: /good|still up/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /welcome/i })).not.toBeInTheDocument();
  });

  it('setup choices are saved', async () => {
    const { user, be } = await boot({}, { onboarded: false });
    await user.click(await screen.findByRole('button', { name: /begin/i }));
    await user.type(screen.getByLabelText(/what should we call you/i), 'Bek');
    await user.click(screen.getByLabelText(/remembering what i study/i));
    await user.click(screen.getByRole('radio', { name: '45 min' }));
    await user.click(screen.getByRole('button', { name: /enter focus os/i }));
    await waitFor(async () => {
      const s = (await readDocs(be, 'settings'))[0];
      expect(s).toMatchObject({ onboarded: true, displayName: 'Bek', homeFocus: 'learn' });
      expect(s.focus.focusMin).toBe(45);
    });
  });
});

describe('Today: focus timer', () => {
  it('starts, pauses, resumes and logs a session; the linked task is NOT completed', async () => {
    const { user, be } = await boot({ subjects: [subject()], tasks: [task()] });
    await screen.findByRole('timer');
    await user.selectOptions(screen.getByLabelText('Working on'), 't1');
    await user.click(screen.getByRole('button', { name: /start 25 min/i }));
    expect(await screen.findByRole('button', { name: /pause/i })).toBeInTheDocument();
    expect(useTimer.getState().timer?.taskId).toBe('t1');
    // drive the clock deterministically through the store (the real heartbeat does exactly this)
    const t0 = useTimer.getState().timer!.segments[0]!.start;
    act(() => { for (let s = 5; s <= 120; s += 5) useTimer.getState().tick(t0 + s * 1000); });
    await user.click(screen.getByRole('button', { name: /pause/i }));
    expect(await screen.findByRole('button', { name: /resume/i })).toBeInTheDocument();
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /end & log/i }));
    await waitFor(async () => expect(await readDocs(be, 'sessions')).toHaveLength(1));
    const [ses] = await readDocs(be, 'sessions');
    expect(ses).toMatchObject({ kind: 'focus', taskId: 't1', outcome: 'stopped' });
    expect(ses.activeMs).toBeGreaterThan(100_000);
    const [t] = await readDocs(be, 'tasks');
    expect(t.status).toBe('todo');
    expect(t.actualMin).toBe(2);
  });

  it('keyboard: Space starts and pauses the timer', async () => {
    const { user } = await boot();
    await screen.findByRole('timer');
    await user.keyboard(' ');
    await waitFor(() => expect(useTimer.getState().timer?.status).toBe('running'));
    await user.keyboard(' ');
    await waitFor(() => expect(useTimer.getState().timer?.status).toBe('paused'));
  });

  it('recovers an interrupted session after restart and says so', async () => {
    const old = Date.now() - 3 * 3600_000;
    await boot({ timer: [{ id: 'active', kind: 'focus', plannedMs: 1500000, status: 'running', segments: [{ start: old, end: null }], lastHeartbeat: old + 7 * 60_000 }] });
    expect(await screen.findByText(/session interrupted/i)).toBeInTheDocument();
    expect(screen.getByText(/7 min were counted/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /resume/i })).toBeInTheDocument();
  });
});

describe('navigation, palette and shortcuts', () => {
  it('number keys and the command palette move between sections', async () => {
    const { user } = await boot();
    await screen.findByRole('timer');
    await user.keyboard('4');
    expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /plan/i })).toHaveAttribute('aria-current', 'page');
    await user.keyboard('{Control>}k{/Control}');
    const box = await screen.findByLabelText(/search commands, notes and cards/i);
    await user.type(box, 'limits');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Limits' })).toBeInTheDocument();
  });

  it('palette "New task" opens the task form', async () => {
    const { user } = await boot();
    await screen.findByRole('timer');
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByLabelText(/search commands, notes and cards/i), 'new task');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'New task' })).toBeInTheDocument();
  });

  it('palette finds notes by content', async () => {
    const { user } = await boot({ subjects: [subject()], notes: [{ id: 'n1', subjectId: 'math', title: 'Vieta', body: 'sum of roots equals -b/a', createdAt: 1, updatedAt: 2 }] });
    await screen.findByRole('timer');
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByLabelText(/search commands, notes and cards/i), 'sum of roots');
    expect(await screen.findByRole('option', { name: /Vieta/ })).toBeInTheDocument();
  });
});

describe('Plan', () => {
  it('validates, saves a task, completes it only when asked, and offers undo', async () => {
    const { user, be } = await boot({ subjects: [subject()] }, { route: 'plan' });
    await user.click(await screen.findByRole('button', { name: /new task/i }));
    const dlg = await screen.findByRole('dialog', { name: 'New task' });
    await user.click(within(dlg).getByRole('button', { name: 'Add task' }));
    expect(await within(dlg).findByText('What needs doing?')).toBeInTheDocument();
    await user.type(within(dlg).getByLabelText('Task'), 'Chemistry lab report');
    await user.clear(within(dlg).getByLabelText(/estimate/i));
    await user.type(within(dlg).getByLabelText(/estimate/i), '2');
    await user.click(within(dlg).getByRole('button', { name: 'Add task' }));
    expect(await within(dlg).findByText(/between 5 and 960/)).toBeInTheDocument();
    await user.clear(within(dlg).getByLabelText(/estimate/i));
    await user.type(within(dlg).getByLabelText(/estimate/i), '45');
    await user.click(within(dlg).getByRole('button', { name: 'Add task' }));
    await waitFor(async () => expect(await readDocs(be, 'tasks')).toHaveLength(1));
    expect((await readDocs(be, 'tasks'))[0]).toMatchObject({ title: 'Chemistry lab report', estimateMin: 45, status: 'todo' });
    await user.click(await screen.findByRole('checkbox', { name: /mark “chemistry lab report” as done/i }));
    await waitFor(async () => expect((await readDocs(be, 'tasks'))[0].status).toBe('done'));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await readDocs(be, 'tasks'))[0].status).toBe('todo'));
  });

  it('an overrunning task gets supportive advice, not a penalty', async () => {
    const { user, be } = await boot({ tasks: [task({ estimateMin: 30, actualMin: 45 })] }, { route: 'plan' });
    expect(await screen.findByText(/taking longer than the 30 min you estimated — that’s normal/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add 20 min' }));
    await waitFor(async () => expect((await readDocs(be, 'tasks'))[0].estimateMin).toBe(65));
  });

  it('missed plans are proposed, not silently moved', async () => {
    const { user, be } = await boot({ tasks: [task({ plannedDay: dayOffset(-2), due: dayOffset(3) })] }, { route: 'plan' });
    expect(await screen.findByText(/1 planned task was missed/i)).toBeInTheDocument();
    expect((await readDocs(be, 'tasks'))[0].plannedDay).toBe(dayOffset(-2)); // untouched so far
    await user.click(screen.getByRole('button', { name: /review new days/i }));
    const dlg = await screen.findByRole('dialog', { name: /move missed tasks/i });
    await user.click(within(dlg).getByRole('button', { name: 'Move selected' }));
    await waitFor(async () => expect((await readDocs(be, 'tasks'))[0].plannedDay >= TODAY()).toBe(true));
  });

  it('exam revision plan is generated and only added on confirmation', async () => {
    const { user, be } = await boot({ subjects: [subject()], topics: [{ id: 'tp', subjectId: 'math', name: 'Algebra', archived: false, createdAt: 1 }], exams: [{ id: 'e1', subjectId: 'math', title: 'Maths midterm', date: dayOffset(6), topicIds: [], createdAt: 1 }] }, { route: 'plan' });
    await user.click(await screen.findByRole('tab', { name: 'Exams' }));
    await user.click(await screen.findByRole('button', { name: /plan revision/i }));
    const dlg = await screen.findByRole('dialog', { name: /revision plan/i });
    expect(within(dlg).getByText('Study: Algebra')).toBeInTheDocument();
    expect(await readDocs(be, 'tasks')).toHaveLength(0);
    await user.click(within(dlg).getByRole('button', { name: /add to my plan/i }));
    await waitFor(async () => expect((await readDocs(be, 'tasks')).length).toBeGreaterThanOrEqual(2));
    expect((await readDocs(be, 'tasks')).every((t: { examId: string }) => t.examId === 'e1')).toBe(true);
  });
});

describe('Library', () => {
  it('creates a subject, then a note that autosaves and survives a reload', async () => {
    const { user, be, unmount } = await boot({}, { route: 'library' });
    await user.click(await screen.findByRole('button', { name: /create a subject/i }));
    await user.type(await screen.findByLabelText('Name'), 'Biology');
    await user.click(screen.getByRole('button', { name: 'Create subject' }));
    await user.click(await screen.findByRole('button', { name: /write the first note/i }));
    await user.type(await screen.findByLabelText('Note title'), 'Mitosis');
    await user.type(screen.getByLabelText('Note body'), '# Phases{enter}- prophase');
    // wait for the debounced autosave to really land in storage, then for the UI to say so
    await waitFor(async () => expect((await readDocs(be, 'notes'))[0]?.body ?? '').toContain('prophase'), { timeout: 5000 });
    expect((await readDocs(be, 'notes'))[0]).toMatchObject({ title: 'Mitosis' });
    await waitFor(() => expect(screen.getByText(/^Saved \d/)).toBeInTheDocument());
    unmount();
    await boot({ subjects: await readDocs(be, 'subjects'), notes: await readDocs(be, 'notes') }, { route: 'library' });
    expect(await screen.findByText('Mitosis')).toBeInTheDocument();
  });

  it('deleting a subject needs confirmation and states exactly what is lost', async () => {
    const { user, be } = await boot({ subjects: [subject()], notes: [{ id: 'n1', subjectId: 'math', title: 'N', body: 'x', createdAt: 1, updatedAt: 1 }], cards: [card()] }, { route: 'library' });
    useUI.setState({ libSubjectId: 'math' });
    await user.click(await screen.findByRole('button', { name: 'Delete subject' }));
    const dlg = await screen.findByRole('dialog', { name: /delete this subject/i });
    expect(within(dlg).getByText(/1 notes/)).toBeInTheDocument();
    expect(within(dlg).getByText(/1 flashcards/)).toBeInTheDocument();
    expect(await readDocs(be, 'subjects')).toHaveLength(1);
    await user.click(within(dlg).getByRole('button', { name: /delete permanently/i }));
    await waitFor(async () => { expect(await readDocs(be, 'subjects')).toHaveLength(0); expect(await readDocs(be, 'cards')).toHaveLength(0); });
  });

  it('adds a flashcard and rejects an empty one', async () => {
    const { user, be } = await boot({ subjects: [subject()] }, { route: 'library' });
    useUI.setState({ libSubjectId: 'math', libTab: 'cards' });
    await user.click(await screen.findByRole('button', { name: 'Add card' }));
    expect(await screen.findByText(/write both a question and its answer/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Front'), 'Derivative of x²?');
    await user.type(screen.getByLabelText('Back'), '2x');
    await user.click(screen.getByRole('button', { name: 'Add card' }));
    await waitFor(async () => expect(await readDocs(be, 'cards')).toHaveLength(1));
    expect((await readDocs(be, 'cards'))[0].srs.state).toBe('new');
  });
});

describe('Review', () => {
  it('reveals, grades with Good, persists schedule + history, and supports undo', async () => {
    const { user, be } = await boot({ subjects: [subject()], cards: [card()] }, { route: 'review' });
    await user.click(await screen.findByRole('button', { name: /start review/i }));
    expect(await screen.findByText('What is 2+2?')).toBeInTheDocument();
    expect(screen.queryByLabelText('Answer')).not.toBeInTheDocument(); // answer hidden until asked
    await user.click(screen.getByRole('button', { name: /show answer/i }));
    expect(await screen.findByLabelText('Answer')).toHaveTextContent('4');
    await user.keyboard('3'); // Good
    await waitFor(async () => expect(await readDocs(be, 'reviews')).toHaveLength(1));
    const [c] = await readDocs(be, 'cards');
    expect(c.srs.interval).toBeGreaterThan(5);
    expect(c.srs.due > TODAY()).toBe(true);
    expect(await screen.findByText(/session complete/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /undo last answer/i }));
    await waitFor(async () => { expect(await readDocs(be, 'reviews')).toHaveLength(0); expect((await readDocs(be, 'cards'))[0].srs.interval).toBe(5); });
  });

  it('a quiz records mistakes and can turn them into flashcards', async () => {
    const quiz = { id: 'q1', subjectId: 'math', title: 'Arithmetic', createdAt: 1, updatedAt: 1, questions: [
      { type: 'mc', id: 'a', prompt: 'Pick the even number', choices: ['3', '4'], answerIndex: 1, explanation: '4 is divisible by 2.' },
      { type: 'short', id: 'b', prompt: 'What is 6 × 7?', answers: ['42'] }] };
    const { user, be } = await boot({ subjects: [subject()], quizzes: [quiz] }, { route: 'review' });
    await user.click(await screen.findByRole('button', { name: /take/i }));
    await user.click(await screen.findByRole('radio', { name: /3/ }));
    await user.click(screen.getByRole('button', { name: /check answer/i }));
    expect(await screen.findByText(/not quite/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /next question/i }));
    await user.type(await screen.findByLabelText('Your answer'), '42');
    await user.click(screen.getByRole('button', { name: /check answer/i }));
    await user.click(screen.getByRole('button', { name: /finish/i }));
    expect(await screen.findByText(/1 of 2 correct/i)).toBeInTheDocument();
    await waitFor(async () => expect((await readDocs(be, 'attempts'))[0]).toMatchObject({ correct: 1, total: 2 }));
    expect(await readDocs(be, 'cards')).toHaveLength(0); // nothing is created behind the student's back
    await user.click(screen.getByRole('button', { name: /turn mistakes into flashcards/i }));
    await waitFor(async () => expect(await readDocs(be, 'cards')).toHaveLength(1));
    expect((await readDocs(be, 'cards'))[0]).toMatchObject({ source: 'quiz-mistake', front: 'Pick the even number' });
    expect((await readDocs(be, 'cards'))[0].back).toContain('4 is divisible by 2');
  });
});

describe('Review: near-miss short answers', () => {
  const quiz = { id: 'q1', subjectId: 'math', title: 'Capitals', createdAt: 1, updatedAt: 1, questions: [{ type: 'short', id: 'a', prompt: 'Capital of France?', answers: ['Paris'] }] };

  it('asks the student to judge a near-miss; "No" counts it as a mistake and stops asking', async () => {
    const { user, be } = await boot({ subjects: [subject()], quizzes: [quiz] }, { route: 'review' });
    await user.click(await screen.findByRole('button', { name: /take/i }));
    await user.type(await screen.findByLabelText('Your answer'), 'Pariss');
    await user.click(screen.getByRole('button', { name: /check answer/i }));
    expect(await screen.findByText(/very close/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /finish/i })).toBeDisabled(); // cannot skip the decision
    await user.click(screen.getByRole('button', { name: 'No' }));
    expect(await screen.findByText(/not quite/i)).toBeInTheDocument();
    expect(screen.queryByText(/do you count it as correct/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /finish/i }));
    await waitFor(async () => expect((await readDocs(be, 'attempts'))[0]).toMatchObject({ correct: 0, total: 1 }));
  });

  it('"Yes, count it" scores the answer as correct', async () => {
    const { user, be } = await boot({ subjects: [subject()], quizzes: [quiz] }, { route: 'review' });
    await user.click(await screen.findByRole('button', { name: /take/i }));
    await user.type(await screen.findByLabelText('Your answer'), 'Pariss');
    await user.click(screen.getByRole('button', { name: /check answer/i }));
    await user.click(await screen.findByRole('button', { name: /yes, count it/i }));
    await user.click(await screen.findByRole('button', { name: /finish/i }));
    await waitFor(async () => expect((await readDocs(be, 'attempts'))[0]).toMatchObject({ correct: 1, total: 1 }));
  });
});

describe('Limits (browser preview: nothing can be enforced and the UI must say so)', () => {
  it('shows configured-but-not-enforced, and keeps measured and self-reported apart', async () => {
    await boot({
      limits: [{ id: 'l1', platform: 'youtube', dailyMinutes: 30, days: [0, 1, 2, 3, 4, 5, 6], allowedStart: null, allowedEnd: null, warnAtPct: 80, enabled: true, createdAt: 1 }],
      manual_usage: [{ id: 'm1', day: TODAY(), platform: 'youtube', minutes: 12, at: 1 }],
    }, { route: 'limits' });
    expect(await screen.findByText('Desktop app only')).toBeInTheDocument();
    const row = (await screen.findByText('YouTube', { selector: 'p' })).closest('[role=listitem]') as HTMLElement;
    expect(within(row).getByText('Not enforced')).toBeInTheDocument();
    expect(within(row).getByText(/Configured, but not enforced/)).toBeInTheDocument();
    expect(within(row).getByText(/Measured/).parentElement).toHaveTextContent('Measured 0 min');
    expect(within(row).getByText(/Self-reported/).parentElement).toHaveTextContent('Self-reported 12 min');
    expect(screen.getByText(/never measured automatically/i)).toBeInTheDocument();
  });

  it('creates a personal rule with validation', async () => {
    const { user, be } = await boot({}, { route: 'limits' });
    await user.click(await screen.findByRole('button', { name: /set a limit/i }));
    const dlg = await screen.findByRole('dialog', { name: 'Set a limit' });
    await user.selectOptions(within(dlg).getByLabelText('Platform'), 'tiktok');
    await user.clear(within(dlg).getByLabelText('Minutes per day'));
    await user.type(within(dlg).getByLabelText('Minutes per day'), '9999');
    await user.click(within(dlg).getByRole('button', { name: 'Save rule' }));
    expect(await within(dlg).findByText(/between 0 and 1440/)).toBeInTheDocument();
    await user.clear(within(dlg).getByLabelText('Minutes per day'));
    await user.type(within(dlg).getByLabelText('Minutes per day'), '20');
    await user.click(within(dlg).getByRole('button', { name: 'Save rule' }));
    await waitFor(async () => expect((await readDocs(be, 'limits'))[0]).toMatchObject({ platform: 'tiktok', dailyMinutes: 20 }));
  });
});

describe('Settings and data ownership', () => {
  it('delete-all needs the word DELETE and takes a backup first', async () => {
    const { user, be } = await boot({ subjects: [subject()], tasks: [task()] }, { route: 'settings' });
    await user.click(await screen.findByRole('button', { name: /delete all my study data/i }));
    const dlg = await screen.findByRole('dialog', { name: /delete all study data/i });
    const go = within(dlg).getByRole('button', { name: 'Delete everything' });
    expect(go).toBeDisabled();
    await user.type(within(dlg).getByLabelText(/type delete/i), 'delete');
    expect(go).toBeDisabled();
    await user.clear(within(dlg).getByLabelText(/type delete/i));
    await user.type(within(dlg).getByLabelText(/type delete/i), 'DELETE');
    await user.click(go);
    await waitFor(async () => expect(await readDocs(be, 'tasks')).toHaveLength(0));
    expect((await be.listBackups()).length).toBeGreaterThan(0);
  });

  it('backup → change → restore round-trips through the UI', async () => {
    const { user, be } = await boot({ subjects: [subject()] }, { route: 'settings' });
    await user.click(await screen.findByRole('button', { name: /back up now/i }));
    await waitFor(async () => expect((await be.listBackups()).length).toBe(1));
    await useData.getState().put('subjects', subject('art', 'Art'));
    await user.click(await screen.findByRole('button', { name: /restore/i }));
    await user.click(await within(await screen.findByRole('dialog', { name: /restore this backup/i })).findByRole('button', { name: 'Restore' }));
    await waitFor(async () => expect((await readDocs(be, 'subjects')).map((s: { id: string }) => s.id)).toEqual(['math']));
  });

  it('reports unreadable stored items without deleting them', async () => {
    const { be } = await boot({ subjects: [subject()] }, { route: 'settings' });
    await be.write([{ op: 'put', collection: 'subjects', id: 'bad', json: '{"id":"bad","name":""}' }]);
    await act(async () => { await useData.getState().load(); });
    expect(await screen.findByText(/1 saved item can’t be read/i)).toBeInTheDocument();
    expect(await be.getAll('subjects')).toHaveLength(2);
  });
});
