import { type ButtonHTMLAttributes, type ComponentProps, type ReactNode, useEffect, useId, useRef, cloneElement, isValidElement, type ReactElement } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { create } from 'zustand';

// ---- Button ---------------------------------------------------------------------

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'quiet' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
};

export function Button({ variant = 'default', size = 'md', busy, className = '', children, disabled, type = 'button', ...rest }: BtnProps) {
  const cls = ['btn', variant === 'primary' && 'btn-primary', variant === 'quiet' && 'btn-quiet', variant === 'danger' && 'btn-danger', size === 'lg' && 'btn-lg', size === 'sm' && 'btn-sm', className].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && <Loader2 size={16} className="spin" aria-hidden />}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" className={`btn btn-quiet icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

// ---- Fields ---------------------------------------------------------------------

interface FieldProps {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;
  className?: string;
}

/** Wires label, hint and error to the control so screen readers announce all three. */
export function Field({ label, hint, error, children, className = '' }: FieldProps) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field ${className}`}>
      <label htmlFor={id}>{label}</label>
      {isValidElement(children) && cloneElement(children, { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {hint && !error && <span className="hint" id={`${id}-hint`}>{hint}</span>}
      {error && (
        <span className="error" id={`${id}-err`} role="alert">
          <AlertTriangle size={14} aria-hidden /> {error}
        </span>
      )}
    </div>
  );
}

export const Input = (p: ComponentProps<'input'>) => <input {...p} className={`input ${p.className ?? ''}`} />;
export const TextArea = (p: ComponentProps<'textarea'>) => <textarea {...p} className={`textarea ${p.className ?? ''}`} />;
export const Select = (p: ComponentProps<'select'>) => <select {...p} className={`select ${p.className ?? ''}`} />;

export function Switch({ checked, onChange, label, disabled, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; description?: string }) {
  const id = useId();
  return (
    <div>
      <label className="switch" htmlFor={id}>
        <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={description ? `${id}-d` : undefined} />
        <span className="track" aria-hidden />
        <span>{label}</span>
      </label>
      {description && <p id={`${id}-d`} className="hint faint" style={{ fontSize: 'var(--fs-small)', marginLeft: 50 }}>{description}</p>}
    </div>
  );
}

export function Segmented<T extends string | number>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  const name = useId();
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={String(o.value)}>
          <input type="radio" name={name} checked={o.value === value} onChange={() => onChange(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

// ---- Status ---------------------------------------------------------------------

export function Pill({ tone, icon, children, title }: { tone?: 'ok' | 'warn' | 'danger' | 'info'; icon?: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span className="pill" data-tone={tone} title={title}>
      {icon}
      {children}
    </span>
  );
}

export function Meter({ value, max, tone, label, mark }: { value: number; max: number; tone?: 'warn' | 'danger'; label: string; mark?: number }) {
  const pct = max <= 0 ? 0 : Math.min(100, (value / max) * 100);
  return (
    <div className="meter" data-tone={tone} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)}>
      <i style={{ width: `${pct}%` }} />
      {mark !== undefined && max > 0 && <span className="mark" style={{ left: `${(mark / max) * 100}%` }} />}
    </div>
  );
}

export function Banner({ tone, title, children, actions }: { tone?: 'danger' | 'info' | 'ok'; title?: string; children?: ReactNode; actions?: ReactNode }) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;
  return (
    <div className="banner" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon size={18} aria-hidden />
      <div className="banner-body">
        {title && <strong>{title}</strong>} {children}
      </div>
      {actions}
    </div>
  );
}

export function SectionHead({ index, title, children }: { index?: string; title: string; children?: ReactNode }) {
  return (
    <div className="sec-head">
      <h2>
        {index && <span className="label">{index}</span>}
        {title}
      </h2>
      {children}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="display-italic">{title}</p>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

// ---- Dialog ---------------------------------------------------------------------

/**
 * Mount-driven modal: the <dialog> exists only while `open`, so form state in the dialog's
 * children starts fresh every time. Uses the native modal behaviour (focus trap, Esc, inert
 * background) and puts focus back on whatever opened it.
 */
export function Dialog({ open, onClose, title, children, footer, wide, description }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean; description?: string }) {
  if (!open) return null;
  return <DialogInner onClose={onClose} title={title} footer={footer} wide={wide} description={description}>{children}</DialogInner>;
}

function DialogInner({ onClose, title, children, footer, wide, description }: Omit<ComponentProps<typeof Dialog>, 'open'>) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    if (d && !d.open) d.showModal();
    // Land on the first field of a form; confirm-only dialogs keep focus on "Close" (the safe default).
    d?.querySelector<HTMLElement>('.dlg-body input:not([type=hidden]):not([disabled]):not([type=radio]):not([type=checkbox]), .dlg-body textarea:not([disabled]), .dlg-body select:not([disabled])')?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dlg"
      data-wide={wide || undefined}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dlg-head">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p className="muted" style={{ marginTop: 4 }}>{description}</p>}
        </div>
        <IconButton label="Close" onClick={onClose}>
          <X size={18} aria-hidden />
        </IconButton>
      </div>
      <div className="dlg-body">{children}</div>
      {footer && <div className="dlg-foot">{footer}</div>}
    </dialog>
  );
}

// ---- Toasts ---------------------------------------------------------------------

interface Toast {
  id: number;
  tone: 'ok' | 'danger' | 'warn' | 'info';
  text: string;
  action?: { label: string; run: () => void };
}
interface ToastStore {
  items: Toast[];
  push(t: Omit<Toast, 'id'>, ttl?: number): void;
  dismiss(id: number): void;
}
let toastId = 0;
export const useToasts = create<ToastStore>((set, get) => ({
  items: [],
  push(t, ttl = 5000) {
    const id = ++toastId;
    set({ items: [...get().items.slice(-3), { ...t, id }] });
    if (ttl > 0) setTimeout(() => get().dismiss(id), t.tone === 'danger' ? Math.max(ttl, 9000) : ttl);
  },
  dismiss: (id) => set({ items: get().items.filter((x) => x.id !== id) }),
}));
export const toast = {
  ok: (text: string, action?: Toast['action']) => useToasts.getState().push({ tone: 'ok', text, action }),
  error: (text: string) => useToasts.getState().push({ tone: 'danger', text }),
  warn: (text: string) => useToasts.getState().push({ tone: 'warn', text }),
  info: (text: string) => useToasts.getState().push({ tone: 'info', text }),
};

export function Toasts() {
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {items.map((t) => {
        const Icon = t.tone === 'ok' ? CheckCircle2 : t.tone === 'info' ? Info : AlertTriangle;
        return (
          <div className="toast" data-tone={t.tone} key={t.id} role={t.tone === 'danger' ? 'alert' : 'status'}>
            <Icon size={18} aria-hidden />
            <div className="toast-body">{t.text}</div>
            {t.action && (
              <Button size="sm" variant="quiet" onClick={() => { t.action!.run(); dismiss(t.id); }}>
                {t.action.label}
              </Button>
            )}
            <IconButton label="Dismiss" onClick={() => dismiss(t.id)} style={{ width: 32, height: 32 }}>
              <X size={14} aria-hidden />
            </IconButton>
          </div>
        );
      })}
    </div>
  );
}

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;

/** Run an async action, toast any failure with its real message, return success. */
export async function attempt<T>(fn: () => Promise<T>, failPrefix = 'That did not work'): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    toast.error(`${failPrefix}: ${(e as Error).message}`);
    return { ok: false };
  }
}
