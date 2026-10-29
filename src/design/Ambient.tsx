/**
 * Decorative depth: a quiet field of twinkling sparkles behind the interface, and small CSS-3D objects.
 * Everything here is `aria-hidden`, never receives pointer events, uses transforms/opacity only, and is
 * switched off by the in-app "Ambient effects" setting. Under reduced motion the CSS collapses the
 * animations, leaving still, faint shapes.
 */

interface Spark {
  x: number;
  y: number;
  size: number;
  dur: number;
  delay: number;
  o: number;
}

/** Deterministic layout (no randomness at render time): a small linear-congruential generator. */
function makeSparks(n: number): Spark[] {
  let s = 20260101;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  return Array.from({ length: n }, () => ({
    x: Math.round(rnd() * 1000) / 10,
    y: Math.round(rnd() * 1000) / 10,
    size: 3 + Math.round(rnd() * 4),
    dur: 3.5 + Math.round(rnd() * 60) / 10,
    delay: -Math.round(rnd() * 90) / 10,
    o: 0.18 + Math.round(rnd() * 27) / 100,
  }));
}

const SPARKS = makeSparks(22);

export function Ambient() {
  return (
    <div className="ambient" aria-hidden="true">
      <i className="ambient-glow ambient-glow-a" />
      <i className="ambient-glow ambient-glow-b" />
      {SPARKS.map((p, i) => (
        <i
          key={i}
          className="spark"
          style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.size, height: p.size, ['--d' as string]: `${p.dur}s`, ['--delay' as string]: `${p.delay}s`, ['--o' as string]: p.o }}
        />
      ))}
    </div>
  );
}

/** Three tilted rings turning around a glowing core, echoing the timer dial. */
export function Gyro({ size = 160, className = '' }: { size?: number; className?: string }) {
  return (
    <div className={`gyro ${className}`} style={{ width: size, height: size, ['--gyro-size' as string]: `${size}px` }} aria-hidden="true">
      <div className="gyro-body">
        <i className="gyro-ring" />
        <i className="gyro-ring" />
        <i className="gyro-ring" />
        <i className="gyro-core" />
        <i className="gyro-orbit"><i className="gyro-moon" /></i>
      </div>
    </div>
  );
}

/** A small wireframe cube, used to give empty states a little presence. */
export function Cube({ size = 44 }: { size?: number }) {
  const half = size / 2;
  return (
    <div className="cube" style={{ width: size, height: size }} aria-hidden="true">
      <div className="cube-body">
        {[0, 90, 180, 270].map((r) => <i key={r} className="cube-face" style={{ transform: `rotateY(${r}deg) translateZ(${half}px)` }} />)}
        <i className="cube-face" style={{ transform: `rotateX(90deg) translateZ(${half}px)` }} />
        <i className="cube-face" style={{ transform: `rotateX(-90deg) translateZ(${half}px)` }} />
      </div>
    </div>
  );
}
