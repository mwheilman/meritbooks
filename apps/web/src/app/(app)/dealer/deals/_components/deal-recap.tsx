'use client';

/**
 * Deal recap — the ledger-style breakdown a sales manager and a bookkeeper both
 * read: what the customer owes, how the trade is valued, and the estimated gross.
 * Used live in "Record sale" (preview) and on the deal page (from the saved deal).
 */

import { clsx } from 'clsx';
import { AlertTriangle } from 'lucide-react';
import type { TradeValuationPolicy } from '@/lib/dealer/types';
import { TRADE_POLICY, hintOf, labelOf } from '@/lib/dealer/ui/labels';
import { bpsToPct, money } from '@/lib/dealer/ui/format';
import type { DealRecap } from '@/lib/dealer/ui/deal-math';

function Row({ label, cents, sign, strong, muted, hint }: { label: string; cents: number; sign?: '+' | '−'; strong?: boolean; muted?: boolean; hint?: string }) {
  return (
    <div className={clsx('flex items-baseline justify-between gap-4 py-1.5', strong && 'border-t border-slate-800 pt-2.5')}>
      <dt className={clsx('text-body-sm', strong ? 'font-medium text-white' : muted ? 'text-slate-500' : 'text-slate-300')} title={hint}>
        {label}
      </dt>
      <dd className={clsx('font-mono tabular-nums', strong ? 'text-white' : muted ? 'text-slate-500' : 'text-slate-200')}>
        {sign && cents !== 0 ? `${sign} ` : ''}
        {money(cents)}
      </dd>
    </div>
  );
}

export function DealRecapView({
  salePriceCents,
  taxCents,
  retailRebateCents,
  depositAppliedCents,
  allowanceCents,
  acvCents,
  unitCostCents,
  policy,
  recap,
  overAllowanceWarnBps,
  costIsEstimate,
}: {
  salePriceCents: number;
  taxCents: number;
  retailRebateCents: number;
  depositAppliedCents: number;
  allowanceCents: number | null;
  acvCents: number | null;
  unitCostCents: number;
  policy: TradeValuationPolicy;
  recap: DealRecap;
  overAllowanceWarnBps: number;
  costIsEstimate?: boolean;
}) {
  const hasTrade = recap.trade !== null && allowanceCents !== null;
  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-1 text-caption uppercase tracking-caps text-slate-500">What the customer owes</h3>
        <dl>
          <Row label="Sale price" cents={salePriceCents} />
          {taxCents > 0 && <Row label="Sales tax" cents={taxCents} sign="+" />}
          {hasTrade && <Row label="Trade-in allowance" cents={allowanceCents ?? 0} sign="−" />}
          {recap.lienPayoffCents > 0 && <Row label="Lien payoff on the trade" cents={recap.lienPayoffCents} sign="+" hint="Paid by the dealer to the customer’s lender, added to the deal." />}
          {retailRebateCents > 0 && <Row label="Manufacturer retail rebate" cents={retailRebateCents} sign="−" hint="The manufacturer pays this part of the price." />}
          <Row label="Customer owes (invoice)" cents={recap.receivableCents} strong />
          {depositAppliedCents > 0 && (
            <>
              <Row label="Deposit applied" cents={depositAppliedCents} sign="−" />
              <Row label="Due after deposit" cents={recap.dueAfterDepositCents} strong />
            </>
          )}
        </dl>
      </div>

      {hasTrade && recap.trade && (
        <div>
          <h3 className="mb-1 text-caption uppercase tracking-caps text-slate-500">Trade-in</h3>
          <dl>
            <Row label="Allowance given" cents={allowanceCents ?? 0} />
            <Row label="Appraised value (actual cash value)" cents={acvCents ?? 0} />
            <Row label="Goes on the books at" cents={recap.trade.recordedValueCents} strong hint={hintOf(TRADE_POLICY, policy)} />
            {recap.trade.overAllowanceCents > 0 && <Row label="Over-allowance (reduces gross)" cents={recap.trade.overAllowanceCents} />}
            {recap.trade.underAllowanceCents > 0 && <Row label="Under-allowance" cents={recap.trade.underAllowanceCents} muted />}
          </dl>
          <p className="mt-1 text-xs text-slate-500">Valued at: {labelOf(TRADE_POLICY, policy)} (this client’s policy).</p>
          {recap.overAllowanceWarn && (
            <p className="mt-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-xs text-amber-100" role="alert">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-400" />
              <span>
                Over-allowance is <span className="font-mono tabular-nums">{bpsToPct(recap.overAllowanceBps, 1)}</span> of the price — at or above this
                client’s <span className="font-mono tabular-nums">{bpsToPct(overAllowanceWarnBps, 0)}</span> limit. A sales manager should confirm the
                trade numbers.
              </span>
            </p>
          )}
        </div>
      )}

      <div>
        <h3 className="mb-1 text-caption uppercase tracking-caps text-slate-500">Estimated gross</h3>
        <dl>
          <Row label="Sale price" cents={salePriceCents} />
          <Row label={costIsEstimate ? 'Unit cost (posted so far)' : 'Unit cost'} cents={unitCostCents} sign="−" />
          {(recap.trade?.overAllowanceCents ?? 0) > 0 && <Row label="Over-allowance" cents={recap.trade?.overAllowanceCents ?? 0} sign="−" />}
          <Row label="Estimated gross" cents={recap.estimatedGrossCents} strong />
        </dl>
        <p className="mt-1 text-xs text-slate-500">Before manufacturer incentives that reduce cost.</p>
      </div>
    </div>
  );
}
