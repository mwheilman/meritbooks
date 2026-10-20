'use client';

/**
 * Dealer Pack (D2) form primitives + modal + confirmation dialog.
 * Money inputs take dollars and hand back integer cents (never floats).
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Loader2, X } from 'lucide-react';
import { centsToInput, parseDollarsToCents } from '@/lib/dealer/ui/format';

export function Field({ label, hint, error, children, htmlFor, required }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string; required?: boolean }) {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="mb-1 block text-label text-slate-300">
        {label}
        {required && <span className="ml-0.5 text-red-400" aria-hidden>*</span>}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-xs text-red-400" role="alert">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
};

export function TextInput({ value, onChange, invalid, className, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid || undefined}
      className={clsx('input w-full', invalid && 'input-error', className)}
    />
  );
}

export function DateInput({ value, onChange, invalid, className, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      type="date"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={invalid || undefined}
      className={clsx('input w-full font-mono tabular-nums', invalid && 'input-error', className)}
    />
  );
}

/**
 * Dollars input → cents. Shows the typed text; reports `null` while the text
 * isn't valid money so the form can refuse to submit.
 */
export function MoneyInput({
  cents,
  onChange,
  invalid,
  allowNegative,
  id,
  placeholder = '0.00',
  disabled,
  'aria-label': ariaLabel,
}: {
  cents: number | null;
  onChange: (cents: number | null) => void;
  invalid?: boolean;
  allowNegative?: boolean;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const [text, setText] = useState(centsToInput(cents));
  const last = useRef<number | null>(cents);
  useEffect(() => {
    if (cents !== last.current) {
      setText(centsToInput(cents));
      last.current = cents;
    }
  }, [cents]);
  const bad = text.trim() !== '' && parseDollarsToCents(text, { allowNegative }) === null;
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
      <input
        id={id}
        inputMode="decimal"
        value={text}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={invalid || bad || undefined}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          const c = parseDollarsToCents(e.target.value, { allowNegative });
          last.current = c;
          onChange(c);
        }}
        className={clsx('input w-full pl-6 text-right font-mono tabular-nums', (invalid || bad) && 'input-error')}
      />
    </div>
  );
}

export function Select<V extends string>({
  value,
  onChange,
  options,
  id,
  invalid,
  placeholder,
  disabled,
  'aria-label': ariaLabel,
}: {
  value: V | '';
  onChange: (v: V) => void;
  options: Array<{ value: V; label: string }>;
  id?: string;
  invalid?: boolean;
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value as V)}
      className={clsx('input w-full', invalid && 'input-error')}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function TextArea({ value, onChange, id, rows = 3, invalid, placeholder, maxLength }: { value: string; onChange: (v: string) => void; id?: string; rows?: number; invalid?: boolean; placeholder?: string; maxLength?: number }) {
  return (
    <textarea
      id={id}
      rows={rows}
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
      className={clsx('input w-full resize-y', invalid && 'input-error')}
    />
  );
}

export function Toggle({ checked, onChange, label, id, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string; disabled?: boolean }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-40',
        checked ? 'border-emerald-500 bg-emerald-600' : 'border-slate-600 bg-slate-800',
      )}
    >
      <span className={clsx('inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  );
}

/** Accessible modal: Escape closes, focus moves in, backdrop click closes. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = setTimeout(() => {
      const el = ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not([data-close])');
      (el ?? ref.current)?.focus();
    }, 0);
    // Bubble phase (not capture) so an open picker/popover inside the modal can
    // stopPropagation() its own Escape and close itself without closing the modal.
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={clsx(
          'w-full rounded-xl border border-slate-800 bg-surface-900 shadow-2xl focus:outline-none',
          width === 'sm' && 'max-w-sm',
          width === 'md' && 'max-w-lg',
          width === 'lg' && 'max-w-2xl',
          width === 'xl' && 'max-w-4xl',
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-6 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-subheading text-white">{title}</h2>
            {description && <p className="mt-0.5 text-xs text-slate-400">{description}</p>}
          </div>
          <button data-close type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-slate-500 hover:bg-white/[0.04] hover:text-slate-200">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-6 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Confirmation for destructive / irreversible actions (post, release, void,
 * write-off, sign-off). Optional required reason and/or date.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  danger,
  busy,
  reason,
  date,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (input: { reason: string; date: string }) => void | Promise<void>;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  /** Ask for a reason (required when `required`). */
  reason?: { label: string; required?: boolean; placeholder?: string };
  /** Ask for a date (always required when shown). */
  date?: { label: string; initial: string };
  error?: ReactNode;
}) {
  const [why, setWhy] = useState('');
  const [when, setWhen] = useState(date?.initial ?? '');
  const reasonId = useId();
  const dateId = useId();
  useEffect(() => {
    if (open) {
      setWhy('');
      setWhen(date?.initial ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const missing = (reason?.required && why.trim().length === 0) || (!!date && !/^\d{4}-\d{2}-\d{2}$/.test(when));
  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={title}
      width="sm"
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={clsx('btn-sm inline-flex items-center gap-1.5', danger ? 'btn-danger' : 'btn-primary')}
            disabled={busy || missing}
            onClick={() => void onConfirm({ reason: why.trim(), date: when })}
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-300">
        <div>{body}</div>
        {date && (
          <Field label={date.label} htmlFor={dateId} required>
            <DateInput id={dateId} value={when} onChange={setWhen} />
          </Field>
        )}
        {reason && (
          <Field label={reason.label} htmlFor={reasonId} required={reason.required}>
            <TextArea id={reasonId} value={why} onChange={setWhy} rows={3} placeholder={reason.placeholder} maxLength={500} />
          </Field>
        )}
        {error}
      </div>
    </Modal>
  );
}
