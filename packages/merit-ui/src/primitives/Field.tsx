'use client';

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '../cx';
import { money, parseMoneyToCents } from '../format';
import { useHotkey } from '../hotkeys/HotkeyProvider';
import { Icon } from '../icons/Icon';
import { Kbd } from './Kbd';

interface FieldContextValue {
  id: string;
  describedBy?: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

export interface FieldProps {
  /** Label above the control, 12px Ink-2. */
  label: ReactNode;
  /** Help under the control ("Matches receipt R-5521"). */
  help?: ReactNode;
  /** What's wrong and how to fix it ("Off by 1,240.00 from the GL. Check outstanding deposits."). */
  error?: ReactNode;
  /** Control id; generated when omitted. */
  id?: string;
  className?: string;
  children: ReactNode;
}

/**
 * .field — label, one control, help or error. Controls inside pick up the id,
 * aria-describedby and aria-invalid automatically.
 */
export function Field({ label, help, error, id, className, children }: FieldProps) {
  const auto = useId();
  const controlId = id ?? `f${auto}`;
  const helpId = help != null && error == null ? `${controlId}-help` : undefined;
  const errId = error != null ? `${controlId}-err` : undefined;
  return (
    <div className={cx('field', className)}>
      <label className="field-label" htmlFor={controlId}>
        {label}
      </label>
      <FieldContext.Provider value={{ id: controlId, describedBy: errId ?? helpId, invalid: error != null }}>{children}</FieldContext.Provider>
      {error != null ? (
        <span className="field-error" id={errId}>
          {error}
        </span>
      ) : help != null ? (
        <span className="field-help" id={helpId}>
          {help}
        </span>
      ) : null}
    </div>
  );
}

function useFieldProps(props: { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling' }, invalid?: boolean) {
  const ctx = useContext(FieldContext);
  const isInvalid = invalid ?? ctx?.invalid ?? false;
  return {
    id: props.id ?? ctx?.id,
    'aria-describedby': cx(ctx?.describedBy, props['aria-describedby']) || undefined,
    'aria-invalid': isInvalid || props['aria-invalid'] || undefined,
    isInvalid,
  };
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Brick border + ring. Set automatically inside a <Field error>. */
  invalid?: boolean;
}

/** .input — 32px, square, white, line-2 border; focus = Electric border + 1px ring. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ invalid, className, ...rest }, ref) {
  const f = useFieldProps(rest, invalid);
  return (
    <input
      ref={ref}
      {...rest}
      id={f.id}
      aria-describedby={f['aria-describedby']}
      aria-invalid={f['aria-invalid']}
      className={cx('input', f.isInvalid && 'is-error', className)}
    />
  );
});

export interface MoneyInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'defaultValue' | 'onChange' | 'type'> {
  /** Integer cents, or null for empty. */
  valueCents: number | null;
  /** Called with integer cents (null when empty). Invalid text keeps the last good value and flags the field. */
  onChangeCents: (cents: number | null) => void;
  /** Allow negatives (entered as -12.50 or (12.50)). Default false. */
  allowNegative?: boolean;
  invalid?: boolean;
}

/**
 * .input.input--money — right-aligned tabular figures. Cents in, cents out;
 * the text is parsed without floating point (format.parseMoneyToCents).
 * Shows "3,184.62" at rest and the raw text while editing.
 */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { valueCents, onChangeCents, allowNegative = false, invalid, className, onFocus, onBlur, ...rest },
  ref,
) {
  const f = useFieldProps(rest, invalid);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => (valueCents == null ? '' : money(valueCents)));
  const [bad, setBad] = useState(false);

  useEffect(() => {
    if (!editing) setText(valueCents == null ? '' : money(valueCents));
  }, [valueCents, editing]);

  const commit = useCallback(
    (raw: string) => {
      if (raw.trim() === '') {
        setBad(false);
        onChangeCents(null);
        return;
      }
      const cents = parseMoneyToCents(raw);
      if (cents == null || (!allowNegative && cents < 0)) {
        setBad(true);
        return;
      }
      setBad(false);
      onChangeCents(cents);
    },
    [allowNegative, onChangeCents],
  );

  return (
    <input
      ref={ref}
      {...rest}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      id={f.id}
      aria-describedby={f['aria-describedby']}
      aria-invalid={f.isInvalid || bad || undefined}
      className={cx('input', 'input--money', (f.isInvalid || bad) && 'is-error', className)}
      value={text}
      onFocus={(e) => {
        setEditing(true);
        if (valueCents != null) setText(money(valueCents, { sign: 'minus' }).replace(/,/g, '').replace('−', '-'));
        onFocus?.(e);
      }}
      onChange={(e) => {
        setText(e.target.value);
        commit(e.target.value);
      }}
      onBlur={(e) => {
        setEditing(false);
        commit(e.target.value);
        onBlur?.(e);
      }}
    />
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

/** .select — native select with the kit chevron. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ invalid, className, children, ...rest }, ref) {
  const f = useFieldProps(rest, invalid);
  return (
    <select
      ref={ref}
      {...rest}
      id={f.id}
      aria-describedby={f['aria-describedby']}
      aria-invalid={f['aria-invalid']}
      className={cx('select', f.isInvalid && 'is-error', className)}
    >
      {children}
    </select>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

/** .textarea — 72px minimum, vertical resize. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ invalid, className, ...rest }, ref) {
  const f = useFieldProps(rest, invalid);
  return (
    <textarea
      ref={ref}
      {...rest}
      id={f.id}
      aria-describedby={f['aria-describedby']}
      aria-invalid={f['aria-invalid']}
      className={cx('textarea', f.isInvalid && 'is-error', className)}
    />
  );
});

export interface SearchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Accessible name (the search box has no visible label). */
  'aria-label': string;
  /** Bind "/" to focus this box (one per page — the registry enforces it). */
  slashToFocus?: boolean;
  className?: string;
}

/** .search — icon, input, and the "/" keycap. */
export const Search = forwardRef<HTMLInputElement, SearchProps>(function Search({ slashToFocus = false, className, ...rest }, ref) {
  const own = useRef<HTMLInputElement | null>(null);
  useHotkey(
    slashToFocus ? '/' : null,
    () => {
      own.current?.focus();
      own.current?.select();
    },
    { owner: 'Search', description: 'Focus search' },
  );
  return (
    <label className={cx('search', className)}>
      <Icon name="search" />
      <input
        ref={(el) => {
          own.current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) ref.current = el;
        }}
        type="search"
        autoComplete="off"
        {...rest}
      />
      {slashToFocus && <Kbd>/</Kbd>}
    </label>
  );
});
