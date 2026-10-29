import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useUI } from '../../app/ui-state';
import { Button } from '../../design/ui';
import { TasksTab } from './TasksTab';
import { WeekTab } from './WeekTab';
import { ExamsTab } from './ExamsTab';
import { WeeklyReviewTab } from './WeeklyReviewTab';
import './plan.css';

type Tab = 'tasks' | 'week' | 'exams' | 'review';
const TABS: [Tab, string][] = [['tasks', 'Tasks'], ['week', 'Week'], ['exams', 'Exams'], ['review', 'Weekly review']];

export function Plan() {
  const [pickedTab, setTab] = useState<Tab>('tasks');
  const [taskOpenLocal, setTaskOpen] = useState(false);
  const [examOpenLocal, setExamOpen] = useState(false);
  // The command palette asks for "new task / new exam" through the UI store; derive instead of syncing.
  const pending = useUI((s) => s.pendingAction);
  const tab: Tab = pending === 'new-task' ? 'tasks' : pending === 'new-exam' ? 'exams' : pickedTab;
  const taskOpen = taskOpenLocal || pending === 'new-task';
  const examOpen = examOpenLocal || pending === 'new-exam';
  const closeTask = (v: boolean) => { setTaskOpen(v); if (!v && useUI.getState().pendingAction === 'new-task') useUI.setState({ pendingAction: null }); };
  const closeExam = (v: boolean) => { setExamOpen(v); if (!v && useUI.getState().pendingAction === 'new-exam') useUI.setState({ pendingAction: null }); };

  return (
    <div>
      <header className="page-head">
        <div>
          <p className="label">Homework · exams · the week</p>
          <h1 className="display">Plan</h1>
          <p>Decide what to do next without a rigid schedule. Plans are suggestions — you stay in charge.</p>
        </div>
        <div className="cluster">
          {tab === 'exams' ? <Button variant="primary" onClick={() => closeExam(true)}><Plus size={16} aria-hidden /> New exam</Button> : <Button variant="primary" onClick={() => { setTab('tasks'); closeTask(true); }}><Plus size={16} aria-hidden /> New task</Button>}
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label="Plan sections">
        {TABS.map(([k, l]) => <button key={k} role="tab" className="tab" aria-selected={tab === k} id={`ptab-${k}`} aria-controls="plan-panel" onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <div role="tabpanel" id="plan-panel" aria-labelledby={`ptab-${tab}`}>
        {tab === 'tasks' && <TasksTab createOpen={taskOpen} setCreateOpen={closeTask} />}
        {tab === 'week' && <WeekTab />}
        {tab === 'exams' && <ExamsTab createOpen={examOpen} setCreateOpen={closeExam} />}
        {tab === 'review' && <WeeklyReviewTab />}
      </div>
    </div>
  );
}
