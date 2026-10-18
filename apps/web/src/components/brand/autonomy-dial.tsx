'use client';

/**
 * AutonomyDial — the segmented-control styling for MeritBooks' autonomy pattern
 * (design criteria §3 Toggles/segmented controls, §4 Autonomy dial + kill switch).
 *
 * off = --surface-2 fill + --hairline-2 border; on = emerald tint + inset emerald
 * ring; each option carries a mono sub-label. This is a presentation primitive —
 * it changes no autonomy behavior and imposes no default. The caller owns the
 * value and the change handler; auto-post stays off by default because the
 * surface that uses this dial keeps its own default.
 *
 * Accessibility: a real radiogroup — arrow keys move selection, Home/End jump to
 * ends, each option is a role="radio" with aria-checked. Full keyboard operable,
 * 2px emerald focus ring, honors prefers-reduced-motion.
 */

import { type ReactNode, useRef } from 'react';
import { clsx } from 'clsx';

export interface AutonomyDialOption<V extends string = string> {
  value: V;
  label: ReactNode;
  /** Mono sub-label under the option label. */
  sublabel?: ReactNode;
  disabled?: boolean;
}

export interface AutonomyDialProps<V extends string = string> {
  options: AutonomyDialOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible group name (required for a labelled radiogroup). */
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

export function AutonomyDial<V extends string = string>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
  className,
}: AutonomyDialProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const enabledIndexes = options
    .map((o, i) => (o.disabled ? -1 : i))
    .filter((i) => i >= 0);

  // When the current value matches no enabled option, keep the group tabbable
  // by making the first enabled option the roving tab stop.
  const hasSelection = options.some((o) => o.value === value && !o.disabled);

  function moveTo(idx: number) {
    const opt = options[idx];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    refs.current[idx]?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent, currentIdx: number) {
    if (disabled) return;
    const pos = enabledIndexes.indexOf(currentIdx);
    if (pos === -1) return;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        moveTo(enabledIndexes[(pos + 1) % enabledIndexes.length]);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        moveTo(enabledIndexes[(pos - 1 + enabledIndexes.length) % enabledIndexes.length]);
        break;
      case 'Home':
        e.preventDefault();
        moveTo(enabledIndexes[0]);
        break;
      case 'End':
        e.preventDefault();
        moveTo(enabledIndexes[enabledIndexes.length - 1]);
        break;
      default:
        break;
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={clsx('grid gap-2', className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((opt, idx) => {
        const selected = opt.value === value;
        const optDisabled = disabled || opt.disabled;
        // Roving tabindex: the selected option is the tab stop.
        const tabbable = selected || (!hasSelection && idx === enabledIndexes[0]);
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[idx] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={optDisabled}
            tabIndex={tabbable ? 0 : -1}
            onClick={() => !optDisabled && onChange(opt.value)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={clsx(
              'rounded-brand px-3 py-2 text-left text-xs transition-colors duration-fast',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-em/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-950',
              'motion-reduce:transition-none',
              optDisabled && 'cursor-not-allowed opacity-40',
              selected
                // on = emerald tint + inset emerald ring
                ? 'bg-em/10 text-white ring-1 ring-inset ring-em/50'
                // off = --surface-2 + --hairline-2
                : 'border border-hairline-strong bg-surface-850 text-ink-mid hover:text-ink-hi',
            )}
          >
            <span className="block font-medium">{opt.label}</span>
            {opt.sublabel != null && (
              <span
                className={clsx(
                  'mt-0.5 block font-mono text-[10px] leading-tight tabular-nums',
                  selected ? 'text-em-bright/80' : 'text-ink-mid',
                )}
              >
                {opt.sublabel}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
