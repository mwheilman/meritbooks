/**
 * Derive CASH-basis presentation adjustments AUTOMATICALLY from the accrual P&L (pure).
 *
 * MeritBooks keeps the GAAP/accrual general ledger as the ONE book of record (CANON
 * GATE 2). "Cash basis" is a PRESENTATION, never a second ledger. The proven cash
 * conversion already lives in `lib/reports/income-statement-cash.ts`
 * (`computeCashIncomeStatement` / `fetchCashIncomeStatement`) — the SAME engine the NL
 * report compiler uses for its FULL cash option. It recognizes revenue when cash is
 * RECEIVED and expense when cash is PAID (i.e. it removes the AR/AP timing that accrual
 * carries).
 *
 * This module DOES NOT reinvent that accounting. It takes the accrual P&L and the cash
 * P&L that engine produces (both already natural-signed, per account) and turns their
 * per-account DIFFERENCE into `reporting_basis_adjustments`-shaped deltas so the Basis
 * toggle can flip Accrual⇆Cash in ONE click with correct numbers and NO hand-keyed rows:
 *
 *     cashAmount_i = accrualAmount_i + delta_i   ⇒   delta_i = cashAmount_i − accrualAmount_i
 *
 * Because the overlay renders `accrualDisplayed + delta`, applying these deltas reproduces
 * the cash P&L EXACTLY, account-for-account (the accrual figures cancel).
 *
 * Balancing (same invariant as `derive-tax.ts`): the accrual trial balance balances
 * (Σ debit-positive = 0). Adjusting only P&L accounts would knock it out of balance by the
 * net-income change, so we book ONE reconciling offset to equity (retained earnings) that
 * cancels the P&L legs in debit-positive space — keeping the adjusted trial balance /
 * balance sheet in balance. The GL is never touched; these never post.
 */

import {
  type BasisAdjustment,
  type NormalBalance,
  toDebitPositive,
} from './apply-adjustments';

/**
 * One P&L account's natural-signed amount under a given basis. `naturalCents` is the same
 * sign space the income-statement payload uses (normal-balance positive), so a straight
 * subtraction of accrual from cash is the presentation delta.
 */
export interface CashPnlAccount {
  accountId: string;
  accountNumber?: string;
  normalBalance: NormalBalance;
  /** natural-signed P&L amount in cents for this account under the basis. */
  naturalCents: number;
}

export interface DerivedCashAdjustments {
  /** the per-account P&L presentation deltas + one balancing equity offset. */
  adjustments: BasisAdjustment[];
  /** natural-signed offset booked to the equity account (for provenance). */
  equityOffsetCents: number;
  /** should be 0 by construction — the derived set balances (when an equity account exists). */
  netDebitPositiveCents: number;
  /** count of non-zero per-account P&L deltas (excludes the equity offset). */
  pnlAdjustmentCount: number;
}

interface Merged {
  normalBalance: NormalBalance;
  accountNumber?: string;
  accrualCents: number;
  cashCents: number;
}

/**
 * Build a balanced set of CASH-basis adjustments from the accrual and cash P&L account
 * amounts. Pure. `equityOffsetAccountId` should be a CREDIT-normal equity account
 * (retained earnings / current-year earnings). When it is null/empty no offset is emitted
 * — the P&L still flips exactly, but the balancing plug is skipped and the caller can
 * surface the resulting (small) imbalance rather than hide it.
 *
 * With identical accrual and cash inputs (no timing difference) the result is empty and
 * balances — which is what makes "no change" provable and keeps GAAP the untouched default.
 */
export function deriveCashAdjustments(
  accrual: readonly CashPnlAccount[],
  cash: readonly CashPnlAccount[],
  equityOffsetAccountId: string | null | undefined,
): DerivedCashAdjustments {
  const byId = new Map<string, Merged>();

  const fold = (rows: readonly CashPnlAccount[], key: 'accrualCents' | 'cashCents') => {
    for (const r of rows) {
      const amt = Math.round(r.naturalCents);
      if (!Number.isFinite(amt)) continue;
      let e = byId.get(r.accountId);
      if (!e) {
        e = { normalBalance: r.normalBalance, accountNumber: r.accountNumber, accrualCents: 0, cashCents: 0 };
        byId.set(r.accountId, e);
      }
      e[key] += amt;
      // Prefer a concrete normal balance / number if a later row carries one.
      e.normalBalance = r.normalBalance ?? e.normalBalance;
      if (r.accountNumber) e.accountNumber = r.accountNumber;
    }
  };
  fold(accrual, 'accrualCents');
  fold(cash, 'cashCents');

  const adjustments: BasisAdjustment[] = [];
  let plDebitPositive = 0;
  let pnlAdjustmentCount = 0;

  // Deterministic ordering by account number then id (stable schedules / snapshots).
  const entries = [...byId.entries()].sort((a, b) => {
    const an = a[1].accountNumber ?? '';
    const bn = b[1].accountNumber ?? '';
    return an.localeCompare(bn) || a[0].localeCompare(b[0]);
  });

  for (const [accountId, e] of entries) {
    const delta = e.cashCents - e.accrualCents; // natural-signed accrual→cash delta
    if (delta === 0) continue;
    pnlAdjustmentCount += 1;
    adjustments.push({
      accountId,
      amountCents: delta,
      adjustmentType: 'TIMING',
      source: 'DERIVED',
      description: 'Accrual-to-cash timing adjustment (recognize on cash movement)',
    });
    plDebitPositive += toDebitPositive(delta, e.normalBalance);
  }

  // One reconciling equity offset cancels the P&L legs in debit-positive space. The equity
  // account is CREDIT-normal, so its debit-positive delta = −naturalEquity; solving
  // plDebitPositive − naturalEquity = 0 gives naturalEquity = plDebitPositive.
  const equityOffsetCents = equityOffsetAccountId ? plDebitPositive : 0;
  if (equityOffsetAccountId && equityOffsetCents !== 0) {
    adjustments.push({
      accountId: equityOffsetAccountId,
      amountCents: equityOffsetCents,
      adjustmentType: 'RECLASS',
      source: 'DERIVED',
      description: 'Cash-basis reconciling offset (net accrual-to-cash income difference to equity)',
    });
  }

  const netDebitPositiveCents =
    plDebitPositive + (equityOffsetAccountId ? toDebitPositive(equityOffsetCents, 'CREDIT') : 0);

  return { adjustments, equityOffsetCents, netDebitPositiveCents, pnlAdjustmentCount };
}
