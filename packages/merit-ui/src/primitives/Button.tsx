'use client';

import { forwardRef, useCallback, useRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx, isDev } from '../cx';
import { ariaKeyshortcuts } from '../hotkeys/chords';
import { useHotkey } from '../hotkeys/HotkeyProvider';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/names';
import { AppLink } from '../provider';
import { ChordCaps } from './Kbd';

export type ButtonVariant = 'default' | 'primary' | 'quiet' | 'danger' | 'dark';
export type ButtonSize = 'md' | 'lg';

interface ButtonOwnProps {
  /** default · primary (one per module) · quiet · danger · dark (on Midnight). */
  variant?: ButtonVariant;
  /** md 32px · lg 40px. */
  size?: ButtonSize;
  /** Leading icon. */
  icon?: IconName;
  /** Trailing icon ("Start Dorrian HVAC →"). */
  iconAfter?: IconName;
  /** Square 32×32 icon-only button; requires aria-label. */
  iconOnly?: boolean;
  /** Key printed beside the verb ("shift+a" → ⇧A). Every action has a key (§7.2). */
  chord?: string;
  /** Also bind `chord` in the hotkey registry to this button's action. */
  bindChord?: boolean;
  /** A tabular count inside the label ("Approve <n>"), set at 500/0.8 like the kit. */
  count?: ReactNode;
  children?: ReactNode;
}

function classes(variant: ButtonVariant, size: ButtonSize, iconOnly: boolean | undefined, extra?: string) {
  return cx('btn', variant !== 'default' && `btn--${variant}`, size === 'lg' && 'btn--lg', iconOnly && 'btn--icon', extra);
}

function Inner({ icon, iconAfter, iconOnly, chord, count, children }: ButtonOwnProps) {
  return (
    <>
      {icon && <Icon name={icon} />}
      {!iconOnly && children}
      {count != null && <span className="n">{count}</span>}
      {iconAfter && <Icon name={iconAfter} />}
      {chord && !iconOnly && <ChordCaps chord={chord} />}
    </>
  );
}

export type ButtonProps = ButtonOwnProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

/** .btn — 32px, square, 600, verbs only. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, iconAfter, iconOnly, chord, bindChord, count, children, className, type = 'button', ...rest },
  ref,
) {
  if (isDev() && iconOnly && !rest['aria-label']) {
    // eslint-disable-next-line no-console
    console.warn('[merit-ui] An icon-only Button needs an aria-label.');
  }
  const { disabled } = rest;
  const own = useRef<HTMLButtonElement | null>(null);
  const setRef = useCallback(
    (el: HTMLButtonElement | null) => {
      own.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );
  // The chord clicks the real button, so onClick gets a real event and a
  // disabled button stays inert.
  useHotkey(
    bindChord ? chord : null,
    () => {
      const el = own.current;
      if (!el || el.disabled) return false;
      el.click();
      return true;
    },
    { owner: typeof children === 'string' ? `Button "${children}"` : 'Button', enabled: !!bindChord && !disabled },
  );
  return (
    <button
      ref={setRef}
      type={type}
      className={classes(variant, size, iconOnly, className)}
      aria-keyshortcuts={chord ? ariaKeyshortcuts(chord) : undefined}
      {...rest}
    >
      <Inner icon={icon} iconAfter={iconAfter} iconOnly={iconOnly} chord={chord} count={count}>
        {children}
      </Inner>
    </button>
  );
});

export type ButtonLinkProps = ButtonOwnProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> & { href: string; disabled?: boolean };

/** A link styled as a button (navigation verbs: "Open requests", "Start Dorrian HVAC"). */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  { variant = 'default', size = 'md', icon, iconAfter, iconOnly, chord, bindChord: _bind, count, children, className, disabled, ...rest },
  ref,
) {
  return (
    <AppLink
      ref={ref}
      className={classes(variant, size, iconOnly, className)}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : rest.tabIndex}
      aria-keyshortcuts={chord ? ariaKeyshortcuts(chord) : undefined}
      {...rest}
    >
      <Inner icon={icon} iconAfter={iconAfter} iconOnly={iconOnly} chord={chord} count={count}>
        {children}
      </Inner>
    </AppLink>
  );
});

/** .btn-row — buttons in a row, 8px apart. */
export function ButtonRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('btn-row', className)}>{children}</div>;
}
