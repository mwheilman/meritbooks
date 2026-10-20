'use client';

import { useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../cx';
import { Button } from '../primitives/Button';
import { Field, Textarea } from '../primitives/Field';
import { useFocusTrap, useMounted } from './focus';

export interface ScrimProps {
  onDismiss?: () => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * .scrim.scrim--fixed through a portal on <body> (the kit scrim: Midnight at 48%), above
 * everything. Render it only after mount (portals are client-only).
 */
export function Scrim({ onDismiss, children, className, style }: ScrimProps) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className={cx('scrim', 'scrim--fixed', className)}
      style={style}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss?.();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Syne title in Midnight (.dialog-head .t-section). */
  title: ReactNode;
  children?: ReactNode;
  /** Right side of the Canvas foot: Cancel + the verb. */
  actions?: ReactNode;
  /** Left side of the foot, a caption ("Widget settings such as band filters are kept."). */
  footNote?: ReactNode;
  /** alertdialog for destructive confirmations. */
  role?: 'dialog' | 'alertdialog';
  /** Width in px (kit: 560; S20 uses 600). */
  width?: number;
  /** Close when the scrim is clicked. Default true (false for typed-reason dialogs). */
  dismissOnScrim?: boolean;
  className?: string;
}

/**
 * .dialog — 560px, square, Midnight border, --float, Canvas foot. Focus is
 * trapped; Esc closes; focus returns to the trigger. Use instead of browser
 * prompt/confirm.
 */
export function Dialog({ open, onClose, title, children, actions, footNote, role = 'dialog', width, dismissOnScrim = true, className }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const mounted = useMounted();
  useFocusTrap(ref, open && mounted);
  if (!open || !mounted) return null;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <Scrim onDismiss={dismissOnScrim ? onClose : undefined}>
      <div
        ref={ref}
        className={cx('dialog', className)}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={children != null ? bodyId : undefined}
        tabIndex={-1}
        style={width ? { width } : undefined}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-head">
          <h2 className="t-section" id={titleId}>
            {title}
          </h2>
        </div>
        {children != null && (
          <div className="dialog-body" id={bodyId}>
            {children}
          </div>
        )}
        {(actions != null || footNote != null) && (
          <div className="dialog-foot">
            {footNote != null && <span className="t-cap">{footNote}</span>}
            <span className="sp" />
            {actions}
          </div>
        )}
      </div>
    </Scrim>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the typed reason when `reason` is set. May be async; the dialog shows busy until it settles. */
  onConfirm: (reason?: string) => void | Promise<void>;
  title: ReactNode;
  children?: ReactNode;
  /** The verb — "Void CO-014", "Reset my home". Never "OK" / "Yes". */
  confirmLabel: string;
  cancelLabel?: string;
  /** danger for destructive verbs (brick), primary otherwise. */
  tone?: 'primary' | 'danger';
  footNote?: ReactNode;
  /** Ask for a typed reason (audit trail). */
  reason?: { label: string; help?: ReactNode; minLength?: number; placeholder?: string };
}

/** A confirmation with a verb button, optional typed reason, and a busy state. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  footNote,
  reason,
}: ConfirmDialogProps) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const min = reason?.minLength ?? (reason ? 1 : 0);
  const ready = !reason || text.trim().length >= min;

  const close = () => {
    if (busy) return;
    setText('');
    setError(null);
    onClose();
  };
  const confirm = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason ? text.trim() : undefined);
      setText('');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={title}
      role={tone === 'danger' ? 'alertdialog' : 'dialog'}
      dismissOnScrim={!reason}
      footNote={footNote}
      actions={
        <>
          <Button onClick={close} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={() => void confirm()} disabled={!ready || busy} aria-busy={busy || undefined}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children != null && <div className="ink-2">{children}</div>}
      {reason && (
        <div style={{ marginTop: children != null ? 16 : 0 }}>
          <Field label={reason.label} help={reason.help} error={error ?? undefined}>
            <Textarea
              data-autofocus
              value={text}
              placeholder={reason.placeholder}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void confirm();
                }
              }}
            />
          </Field>
        </div>
      )}
      {!reason && error != null && (
        <p className="field-error" role="alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}
    </Dialog>
  );
}
