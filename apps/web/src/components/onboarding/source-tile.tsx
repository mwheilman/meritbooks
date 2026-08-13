'use client';

/**
 * SourceTile — one choice on the source-first entry screen ("Where do your books
 * live today?"). The very first thing onboarding asks is a SOURCE, not a field
 * (design spec §1). A tile is a large, keyboard-operable radio-style button.
 *
 * Accessibility: rendered as a `role="radio"` inside a parent `role="radiogroup"`
 * (see SourceStep) with `aria-checked` and an `aria-label`; it's a native <button>,
 * so Tab reaches each tile and Space/Enter selects. Selection is conveyed by border +
 * check icon + aria-checked, not color alone. Tokens only — no hard-coded palette.
 */

import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { clsx } from 'clsx';

export interface SourceTileProps {
  /** Leading glyph — a lucide icon, monogram, or short text node. */
  icon: ReactNode;
  /** Primary label, e.g. "QuickBooks". */
  title: string;
  /** One-line supporting text, e.g. "Connect & import". */
  subtitle: string;
  /** Whether this tile is the current selection. */
  selected: boolean;
  /** Invoked when the user picks this tile (click / Space / Enter). */
  onSelect: () => void;
  /** Disable interaction (e.g. while a connect flow is starting). */
  disabled?: boolean;
  className?: string;
}

export function SourceTile({
  icon, title, subtitle, selected, onSelect, disabled = false, className,
}: SourceTileProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${title} — ${subtitle}`}
      disabled={disabled}
      onClick={onSelect}
      className={clsx(
        'group flex items-center gap-3 rounded-2xl border px-4 py-4 text-left transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
        disabled && 'opacity-50 cursor-not-allowed',
        selected
          ? 'border-brand-500 bg-brand-500/[0.06]'
          : 'border-slate-800 bg-surface-900 hover:border-slate-600 hover:bg-surface-850',
        className,
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold',
          selected ? 'bg-brand-500/15 text-brand-300' : 'bg-surface-950 text-slate-300 border border-slate-800',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-white">{title}</span>
        <span className="block text-xs text-slate-500">{subtitle}</span>
      </span>
      {selected && <Check size={16} className="shrink-0 text-brand-400" aria-hidden />}
    </button>
  );
}
