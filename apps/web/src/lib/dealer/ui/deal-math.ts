/**
 * Dealer Pack (D2 slice A) — deal recap math for the "Record sale" preview and the
 * deal page. Pure and client-safe: it reuses the D1 engine (lib/dealer/engine/sale.ts)
 * so the preview and the posted deal agree to the cent (FPB §3.4, §3.5, R4, DL-11).
 */

import { dealReceivable, overAllowanceBps, valueTradeIn } from '../engine/sale';
import type { LienStatus, TradeValuationPolicy } from '../types';

export interface DealDraft {
  salePriceCents: number;
  taxCents: number;
  retailRebateCents: number;
  depositAppliedCents: number;
  /** The unit's posted cost (what cost of sale will be). */
  unitCostCents: number;
  trade: { allowanceCents: number; acvCents: number; lienPayoffCents: number } | null;
}

export interface DealRecap {
  /** What the customer owes on the Books invoice: price + tax − allowance + lien − rebate. */
  receivableCents: number;
  /** After the deposit is applied to that invoice. */
  dueAfterDepositCents: number;
  trade: { recordedValueCents: number; overAllowanceCents: number; underAllowanceCents: number } | null;
  /** Over-allowance as a share of the price, in bps. */
  overAllowanceBps: number;
  /** DL-11: over-allowance at or above the client's threshold. */
  overAllowanceWarn: boolean;
  /** Price − unit cost − over-allowance (FPB R4, before incentives). */
  estimatedGrossCents: number;
  lienPayoffCents: number;
}

const ok = (n: number) => Number.isInteger(n) && n >= 0;

export function dealRecap(d: DealDraft, policy: TradeValuationPolicy, overAllowanceWarnBps: number): DealRecap {
  const trade =
    d.trade && ok(d.trade.allowanceCents) && ok(d.trade.acvCents)
      ? valueTradeIn({ allowanceCents: d.trade.allowanceCents, acvCents: d.trade.acvCents, policy })
      : null;
  const lien = d.trade && ok(d.trade.lienPayoffCents) ? d.trade.lienPayoffCents : 0;
  const receivable = dealReceivable({
    salePriceCents: d.salePriceCents,
    taxCents: d.taxCents,
    retailRebateCents: d.retailRebateCents,
    trade: d.trade ? { allowanceCents: d.trade.allowanceCents, valuation: trade ?? { recordedValueCents: 0, overAllowanceCents: 0, underAllowanceCents: 0 }, lienPayoffCents: lien } : null,
  });
  const over = trade?.overAllowanceCents ?? 0;
  const bps = overAllowanceBps(over, d.salePriceCents);
  return {
    receivableCents: receivable,
    dueAfterDepositCents: receivable - d.depositAppliedCents,
    trade,
    overAllowanceBps: bps,
    overAllowanceWarn: over > 0 && bps >= overAllowanceWarnBps,
    estimatedGrossCents: d.salePriceCents - d.unitCostCents - over,
    lienPayoffCents: lien,
  };
}

/** A trade needs sales-manager approval when ACV ≥ the client's threshold (0 = every trade). */
export function tradeNeedsApproval(acvCents: number, thresholdCents: number): boolean {
  return acvCents >= thresholdCents;
}

/**
 * DL-11 lien clock: days a trade lien has been owed/proposed since the sale, or null
 * when nothing is owed. `overdue` when strictly more than the client's limit.
 */
export function lienUnpaid(
  lienStatus: LienStatus,
  sinceDate: string | null,
  today: string,
  limitDays: number,
): { days: number; overdue: boolean } | null {
  if ((lienStatus !== 'OWED' && lienStatus !== 'PROPOSED') || !sinceDate) return null;
  const n = (iso: string) => {
    const [y, m, dd] = iso.slice(0, 10).split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, dd) / 86_400_000);
  };
  const days = Math.max(0, n(today) - n(sinceDate));
  return { days, overdue: days > limitDays };
}
