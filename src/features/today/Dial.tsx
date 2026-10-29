import type { ReactNode } from 'react';

interface DialProps {
  /** 0..1 */
  progress: number;
  state: 'idle' | 'running' | 'paused' | 'finished' | 'break';
  children?: ReactNode;
  size?: number;
}

const TICKS = 60;

/** The signature element: a watch-dial built from real geometry (ticks + arc), not decoration. */
export function Dial({ progress, state, children, size = 440 }: DialProps) {
  // `size` is only the SVG's internal coordinate system; CSS controls the rendered size.
  const c = size / 2;
  const r = c - 18;
  const circ = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress));
  const angle = p * 2 * Math.PI - Math.PI / 2;
  const knob = { x: c + r * Math.cos(angle), y: c + r * Math.sin(angle) };
  const litTicks = Math.round(p * TICKS);
  return (
    <div className="dial" data-state={state}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Progress ${Math.round(p * 100)} percent`} focusable="false">
        <circle cx={c} cy={c} r={r} className="dial-track" fill="none" />
        {Array.from({ length: TICKS }, (_, i) => {
          const a = (i / TICKS) * 2 * Math.PI - Math.PI / 2;
          const major = i % 5 === 0;
          const r1 = r - 14;
          const r2 = r1 - (major ? 14 : 7);
          return <line key={i} x1={c + r1 * Math.cos(a)} y1={c + r1 * Math.sin(a)} x2={c + r2 * Math.cos(a)} y2={c + r2 * Math.sin(a)} className={`dial-tick${i < litTicks ? ' lit' : ''}${major ? ' major' : ''}`} />;
        })}
        <circle cx={c} cy={c} r={r} fill="none" className="dial-arc" strokeDasharray={circ} strokeDashoffset={circ * (1 - p)} transform={`rotate(-90 ${c} ${c})`} strokeLinecap="round" />
        {p > 0 && p < 1 && <circle cx={knob.x} cy={knob.y} r={5} className="dial-knob" />}
      </svg>
      <div className="dial-center">{children}</div>
    </div>
  );
}
