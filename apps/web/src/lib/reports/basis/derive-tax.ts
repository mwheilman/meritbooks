/**
 * Derive TAX-basis presentation adjustments from the book-to-tax M-1 differences (pure).
 *
 * The book-to-tax engine (`lib/tax/book-tax.ts`) already resolves, per tagged P&L account,
 * a book-tax difference: a positive magnitude + a taxable effect (ADD ⇒ taxable income is
 * higher than book, SUBTRACT ⇒ lower) + a permanent/temporary character. This module turns
 * that SAME output into `reporting_basis_adjustments` rows so the tax basis is derived, not
 * hand-keyed.
 *
 * For each per-account difference we emit ONE natural-space delta on that P&L account, and
 * we accumulate a SINGLE offsetting delta on a designated equity account so the whole set
 * nets to zero in debit-positive space — i.e. the tax-basis trial balance still balances.
 * (A basis conversion reclassifies income; the offset is the reconciling equity / deferred
 * item. We do NOT model the tax provision here — this is a presentation overlay.)
 *
 * Sign derivation (matches lib/reports/basis/apply-adjustments' natural convention):
 *   netIncomeChange nc = ADD ? +A : −A       (tax net income vs book)
 *   naturalDelta on the account = normalBalance==='DEBIT' ? −nc : +nc
 *     · a nondeductible expense (DEBIT-normal, ADD) → −A  (expense shrinks on tax basis)
 *     · tax-exempt income     (CREDIT-normal, SUBTRACT) → −A (revenue shrinks)
 *     · extra tax deduction   (DEBIT-normal, SUBTRACT) → +A (more expense on tax basis)
 *   Each account's debit-positive delta works out to −nc, so the equity offset is Σnc's
 *   mirror, guaranteeing a zero net.
 */

import type { TaxableEffect, DifferenceType } from '@/lib/tax/book-tax';
import {
  type BasisAdjustment,
  type NormalBalance,
  toDebitPositive,
} from './apply-adjustments';

/** A single per-account book-tax difference (the shape book-tax.ts resolves per account). */
export interface PerAccountTaxDifference {
  accountId: string;
  accountNumber?: string;
  /** DEBIT for expense/COGS accounts, CREDIT for revenue accounts. */
  normalBalance: NormalBalance;
  taxableEffect: TaxableEffect;
  differenceType: DifferenceType;
  /** positive magnitude in cents (as book-tax.ts resolves it). */
  amountCents: number;
  code: string;
  label?: string;
}

export interface DerivedTaxAdjustments {
  /** the per-account P&L presentation deltas + one balancing equity offset. */
  adjustments: BasisAdjustment[];
  /** natural-signed offset booked to the equity account (for provenance). */
  equityOffsetCents: number;
  /** should be 0 by construction — the derived set balances. */
  netDebitPositiveCents: number;
}

/**
 * Build a balanced set of TAX-basis adjustments from resolved per-account differences.
 *
 * `equityOffsetAccountId` MUST be a CREDIT-normal equity account (retained earnings /
 * current-year earnings). With no differences the result is empty and balances.
 */
export function deriveTaxAdjustmentsFromM1(
  diffs: readonly PerAccountTaxDifference[],
  equityOffsetAccountId: string,
): DerivedTaxAdjustments {
  const adjustments: BasisAdjustment[] = [];
  let plDebitPositive = 0;

  for (const d of diffs) {
    const A = Math.abs(Math.round(d.amountCents));
    if (A === 0) continue;
    const nc = d.taxableEffect === 'ADD' ? A : -A; // tax net income vs book
    const naturalDelta = d.normalBalance === 'DEBIT' ? -nc : nc;
    adjustments.push({
      accountId: d.accountId,
      amountCents: naturalDelta,
      adjustmentType: d.differenceType === 'PERMANENT' ? 'PERMANENT' : 'TIMING',
      source: 'DERIVED',
      description: `${d.label ?? d.code} — ${d.taxableEffect === 'ADD' ? 'add to' : 'subtract from'} taxable income (M-1 ${d.code})`,
    });
    plDebitPositive += toDebitPositive(naturalDelta, d.normalBalance);
  }

  // Offset must cancel the P&L legs in debit-positive space. The equity account is
  // CREDIT-normal, so its debit-positive delta = −naturalEquity; solving
  // plDebitPositive − naturalEquity = 0 gives naturalEquity = plDebitPositive.
  const equityOffsetCents = plDebitPositive;
  if (equityOffsetCents !== 0) {
    adjustments.push({
      accountId: equityOffsetAccountId,
      amountCents: equityOffsetCents,
      adjustmentType: 'RECLASS',
      source: 'DERIVED',
      description: 'Tax-basis presentation offset (net book-to-tax difference to equity)',
    });
  }

  const netDebitPositiveCents =
    plDebitPositive + toDebitPositive(equityOffsetCents, 'CREDIT');

  return { adjustments, equityOffsetCents, netDebitPositiveCents };
}
