import { Dialog, Kbd } from '../design/ui';
import { useUI } from './ui-state';

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

const ROWS: [string[], string][] = [
  [[mod, 'K'], 'Command palette'],
  [['1', '–', '7'], 'Go to Today, Library, Review, Plan, Limits, Apps, Class'],
  [['Space'], 'Start / pause the focus timer (Today)'],
  [['Space'], 'Show the answer (card review)'],
  [['1', '–', '4'], 'Grade a card: Again, Hard, Good, Easy (after the answer is shown)'],
  [['?'], 'This list'],
  [['Esc'], 'Close dialogs'],
];

export function Shortcuts() {
  const open = useUI((s) => s.shortcutsOpen);
  return (
    <Dialog open={open} onClose={() => useUI.getState().setShortcuts(false)} title="Keyboard shortcuts">
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {ROWS.map(([keys, what], i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--line)' }}>
              <td style={{ padding: '10px 0', whiteSpace: 'nowrap' }}>{keys.map((k, j) => (k === '–' ? <span key={j}> – </span> : <span key={j}><Kbd>{k}</Kbd> </span>))}</td>
              <td style={{ padding: '10px 0 10px 16px', color: 'var(--text-2)' }}>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
