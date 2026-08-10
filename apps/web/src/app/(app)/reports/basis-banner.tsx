'use client';

import { Landmark, AlertTriangle } from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import type { BasisOverlay } from './use-basis-overlay';

/**
 * The clearly-labeled banner shown above any non-GAAP statement so a reader is never
 * misled: the presentation is an OVERLAY on the accrual ledger, which remains the book of
 * record. Surfaces a hard imbalance warning when the adjustments do not net to zero.
 */
export function BasisBanner({ overlay }: { overlay: BasisOverlay }) {
  if (!overlay.enabled) return null;
  return (
    <div className="mb-3 space-y-2">
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-indigo-500/[0.07] border border-indigo-500/25 text-xs">
        <Landmark size={14} className="text-indigo-400 shrink-0" />
        <span className="text-indigo-200">
          <span className="font-semibold">{overlay.basisLabel} (adjusted presentation)</span>
          {' — '}the GL remains accrual (GAAP). {overlay.count} basis adjustment{overlay.count === 1 ? '' : 's'} layered on top; these never post to the ledger.
        </span>
      </div>
      {!overlay.balances && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs" role="alert">
          <AlertTriangle size={14} className="text-amber-400 shrink-0" />
          <span className="text-amber-200">
            These adjustments do not net to zero — the adjusted trial balance is out of balance by{' '}
            <span className="font-mono font-semibold">{formatMoney(Math.abs(overlay.netDebitPositiveCents))}</span>.
            Add an offsetting balance-sheet adjustment so the presentation ties out.
          </span>
        </div>
      )}
    </div>
  );
}
