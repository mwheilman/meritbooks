'use client';

import { forwardRef, useEffect, useRef, type ForwardedRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx, isDev } from '../cx';

interface ChoiceProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Visible label. Without one, pass aria-label. */
  label?: ReactNode;
  className?: string;
}

function warnUnlabelled(kind: string, label: ReactNode, ariaLabel: string | undefined) {
  if (isDev() && label == null && !ariaLabel) {
    // eslint-disable-next-line no-console
    console.warn(`[merit-ui] ${kind} needs a label or aria-label.`);
  }
}

function mergeRef<T>(ref: ForwardedRef<T>, el: T | null) {
  if (typeof ref === 'function') ref(el);
  else if (ref) ref.current = el;
}

export interface CheckProps extends ChoiceProps {
  /** The "select all" partial state. */
  indeterminate?: boolean;
}

/** .check — 16px square box in a 32px hit area. */
export const Check = forwardRef<HTMLInputElement, CheckProps>(function Check({ label, indeterminate = false, className, ...rest }, ref) {
  warnUnlabelled('Check', label, rest['aria-label']);
  const own = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (own.current) own.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className={cx('check', className)}>
      <input
        ref={(el) => {
          own.current = el;
          mergeRef(ref, el);
        }}
        type="checkbox"
        {...rest}
      />
      <i aria-hidden="true" />
      {label}
    </label>
  );
});

/** .radio — the one circle in the system. */
export const Radio = forwardRef<HTMLInputElement, ChoiceProps>(function Radio({ label, className, ...rest }, ref) {
  warnUnlabelled('Radio', label, rest['aria-label']);
  return (
    <label className={cx('radio', className)}>
      <input ref={ref} type="radio" {...rest} />
      <i aria-hidden="true" />
      {label}
    </label>
  );
});

/** .switch — square track and knob; role="switch". */
export const Switch = forwardRef<HTMLInputElement, ChoiceProps>(function Switch({ label, className, ...rest }, ref) {
  warnUnlabelled('Switch', label, rest['aria-label']);
  return (
    <label className={cx('switch', className)}>
      <input ref={ref} type="checkbox" role="switch" {...rest} />
      <i aria-hidden="true" />
      {label}
    </label>
  );
});
