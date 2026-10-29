import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { ArrowRight } from 'lucide-react';
import { useData } from '../../data/store';
import { SYSTEM_ZONE } from '../../domain/time';
import { Button, Field, Input, Segmented, toast } from '../../design/ui';
import './onboarding.css';

const TITLE = 'FOCUS OS'.split('');

function Ring({ draw }: { draw: boolean }) {
  return (
    <svg className="ob-ring" viewBox="0 0 200 200" aria-hidden focusable="false">
      <circle cx="100" cy="100" r="92" className={`ob-arc${draw ? ' draw' : ''}`} pathLength={1} />
      {Array.from({ length: 60 }, (_, i) => {
        const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
        const major = i % 5 === 0;
        return <line key={i} x1={100 + 78 * Math.cos(a)} y1={100 + 78 * Math.sin(a)} x2={100 + (major ? 66 : 72) * Math.cos(a)} y2={100 + (major ? 66 : 72) * Math.sin(a)} className="ob-tick" style={{ animationDelay: `${0.5 + i * 0.012}s` }} />;
      })}
    </svg>
  );
}

/** First run only. Skippable at every step; no fake progress; nothing is requested from the OS. */
export function Onboarding() {
  const update = useData((s) => s.updateSettings);
  const reduce = useReducedMotion();
  const [step, setStep] = useState<'intro' | 'setup'>('intro');
  const [name, setName] = useState('');
  const [home, setHome] = useState<'plan' | 'learn' | 'limits'>('plan');
  const [focusMin, setFocusMin] = useState(25);
  const [busy, setBusy] = useState(false);

  const finish = async (withChoices: boolean) => {
    setBusy(true);
    try {
      await update((s) => ({
        ...s,
        onboarded: true,
        timeZone: SYSTEM_ZONE(),
        ...(withChoices ? { displayName: name.trim().slice(0, 60), homeFocus: home, focus: { ...s.focus, focusMin } } : {}),
      }));
    } catch (e) {
      toast.error(`Could not save your setup: ${(e as Error).message}`);
      setBusy(false);
    }
  };

  return (
    <div className="ob" role="dialog" aria-modal="true" aria-label="Welcome to FOCUS OS">
      <button className="ob-skip btn btn-quiet btn-sm" onClick={() => void finish(false)} disabled={busy}>
        Skip
      </button>
      {step === 'intro' ? (
        <div className="ob-stage">
          <Ring draw />
          <div className="ob-copy">
            <h1 className="display ob-title" aria-label="FOCUS OS">
              {TITLE.map((ch, i) => (
                <motion.span key={i} aria-hidden initial={reduce ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 + i * 0.045, duration: 0.5, ease: [0.22, 1, 0.36, 1] }} style={{ display: 'inline-block', whiteSpace: 'pre' }}>
                  {ch}
                </motion.span>
              ))}
            </h1>
            <motion.p className="display-italic ob-tag" initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.9, duration: 0.6 }}>
              A quiet place to get your work done.
            </motion.p>
            <motion.div initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.2, duration: 0.4 }}>
              <Button variant="primary" size="lg" onClick={() => setStep('setup')} autoFocus>
                Begin <ArrowRight size={18} aria-hidden />
              </Button>
              <p className="faint ob-note">Everything stays on this computer. No account needed.</p>
            </motion.div>
          </div>
        </div>
      ) : (
        <motion.form className="ob-setup" initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }} onSubmit={(e) => { e.preventDefault(); void finish(true); }}>
          <p className="label">Three quick choices</p>
          <h1 className="display" style={{ fontSize: 'var(--fs-h1)', margin: 'var(--s-3) 0 var(--s-6)' }}>Make it yours.</h1>
          <div className="stack" style={{ gap: 'var(--s-6)' }}>
            <Field label="What should we call you? (optional)" hint="Only used for the greeting. Stays on this device.">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus autoComplete="off" />
            </Field>
            <fieldset className="ob-choice">
              <legend className="field-label">What do you want help with first?</legend>
              {([['plan', 'Keeping track of homework and exams'], ['learn', 'Remembering what I study'], ['limits', 'Spending less time on distractions']] as const).map(([v, text], i) => (
                <label key={v} className="ob-opt">
                  <input type="radio" name="home" checked={home === v} onChange={() => setHome(v)} />
                  <span className="label">0{i + 1}</span>
                  <span>{text}</span>
                </label>
              ))}
            </fieldset>
            <div className="field">
              <span className="field-label">A comfortable focus block</span>
              <Segmented label="Focus block length" value={focusMin} onChange={setFocusMin} options={[{ value: 15, label: '15 min' }, { value: 25, label: '25 min' }, { value: 45, label: '45 min' }]} />
            </div>
          </div>
          <div className="cluster" style={{ marginTop: 'var(--s-7)' }}>
            <Button type="submit" variant="primary" size="lg" busy={busy}>Enter FOCUS OS <ArrowRight size={18} aria-hidden /></Button>
            <Button variant="quiet" onClick={() => void finish(false)} disabled={busy}>Use defaults</Button>
          </div>
        </motion.form>
      )}
    </div>
  );
}
