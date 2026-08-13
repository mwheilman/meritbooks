'use client';

/**
 * TieOutBanner — the emotional payoff of onboarding (design spec §1): the single
 * line that turns "I hope I set this up right" into "it's PROVEN right".
 *
 *   • 'balanced' → "Balanced to the penny ✓" with debits = credits (emerald, mono).
 *   • 'off'      → out of balance by a stated amount (calm amber, not alarmist).
 *   • 'pending'  → not yet computed / still importing.
 *
 * Numbers are JetBrains Mono + tabular-nums so the equals sign lines up. Money is
 * cents (bigint-safe number) formatted via the shared money util — this component
 * never does monetary arithmetic itself.
 *
 * Accessibility: `role="status"` + `aria-live="polite"` so the tie-out result is
 * announced when it flips; the state is conveyed by text + icon, not color alone.
 */

import { CircleCheck, AlertTriangle, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';

export type TieOutState = 'balanced' | 'off' | 'pending';

export interface TieOutBannerProps {
  state: TieOutState;
  /** Total debits, in cents. */
  debitsCents: number;
  /** Total credits, in cents. */
  creditsCents: number;
  /** Optional supporting line (e.g. "Assets = Liabilities + Equity"). */
  note?: string;
  className?: string;
}

export function TieOutBanner({ state, debitsCents, creditsCents, note, className }: TieOutBannerProps) {
  const diff = Math.abs(debitsCents - creditsCents);

  if (state === 'pending') {
    return (
      <div
        role="status"
        aria-live="polite"
        className={clsx(
          'flex items-center justify-center gap-2 rounded-2xl border border-slate-800 bg-surface-900/60 px-5 py-6 text-sm text-slate-400',
          className,
        )}
      >
        <Loader2 size={16} className="animate-spin" aria-hidden />
        Bringing your opening balances over…
      </div>
    );
  }

  if (state === 'off') {
    const side = debitsCents > creditsCents ? 'debits exceed credits' : 'credits exceed debits';
    return (
      <div
        role="status"
        aria-live="polite"
        className={clsx(
          'rounded-2xl border border-warning/30 bg-warning/5 px-5 py-5 text-center',
          className,
        )}
      >
        <div className="flex items-center justify-center gap-2 text-sm font-medium text-warning-fg">
          <AlertTriangle size={16} aria-hidden /> Not balanced yet
        </div>
        <p className="mt-2 font-mono text-base tabular-nums text-slate-200">
          {formatMoney(debitsCents)} <span className="text-slate-500">vs</span> {formatMoney(creditsCents)}
        </p>
        <p className="mt-1.5 text-xs text-slate-500">
          Off by <span className="font-mono tabular-nums text-warning-fg">{formatMoney(diff)}</span> — {side}. We&apos;ll
          get this to zero before you go live.
        </p>
      </div>
    );
  }

  // balanced
  return (
    <div
      role="status"
      aria-live="polite"
      className={clsx(
        'rounded-2xl border border-brand-500/30 bg-brand-500/[0.05] px-5 py-6 text-center',
        className,
      )}
    >
      <div className="flex items-center justify-center gap-2 text-base font-semibold text-brand-400">
        <CircleCheck size={18} aria-hidden /> Balanced to the penny.
      </div>
      <p className="mt-3 font-mono text-lg tabular-nums text-white">
        {formatMoney(debitsCents)} <span className="text-brand-400">=</span> {formatMoney(creditsCents)}
      </p>
      <p className="mt-2 text-xs text-slate-500">{note ?? 'Total debits = total credits · Assets = Liabilities + Equity'}</p>
    </div>
  );
}
