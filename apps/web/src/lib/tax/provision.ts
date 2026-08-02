/**
 * Income Tax Provision engine (ASC 740) — the PURE, deterministic, I/O-free heart of the
 * current + deferred tax computation.
 *
 * Book net income ≠ the income-tax expense a company reports. ASC 740 splits the tax into a
 * CURRENT piece (what is owed on this year's taxable income) and a DEFERRED piece (the tax
 * effect of TEMPORARY differences that will reverse in a later year, recorded as a change in
 * a Deferred Tax Asset or Liability). This module consumes the SAME permanent/temporary split
 * the Schedule M-1/M-3 engine (book-tax.ts / m1-report.ts) already produces — so the provision
 * ties to the ledger by construction — and does only integer-cent arithmetic:
 *
 *   permanent net    = permanent additions − permanent subtractions   (never reverses)
 *   temporary net    = temporary additions − temporary subtractions   (reverses later)
 *   taxable income   = pretax book income + permanent net + temporary net
 *   current tax      = taxable income × statutory rate
 *   Δ DTA            = temporary ADDITIONS × rate   (deductible temp diffs → future benefit)
 *   Δ DTL            = temporary SUBTRACTIONS × rate (taxable temp diffs → future tax)
 *   deferred tax     = Δ DTL − Δ DTA                (expense +, benefit −)
 *   total provision  = current tax + deferred tax  ≡  (pretax + permanent net) × rate
 *
 * The identity `total = (pretax + permanent net) × rate` is the effective-rate story: only
 * PERMANENT differences move the effective rate away from statutory; temporary differences
 * merely shift tax between current and deferred and cancel out of the total.
 *
 * Sign convention (mirrors book-tax.ts): all difference magnitudes are POSITIVE; the ADD /
 * SUBTRACT character decides the side. A negative pretax book income (a book loss) flows
 * through cleanly — current tax, deferred tax, and the total provision all become benefits
 * (negative), and the JE builder simply flips the debit/credit sides.
 *
 * There is NO I/O here and NO floating-point money — the whole file is exhaustively
 * unit-testable and can never drift from the M-1 it is fed.
 */

import type { JournalEntryLineInput } from '@/lib/services/gl-posting';

// ─────────────────────────────────────────────────────────────────────────────
// Inputs / outputs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The provision inputs. `pretaxBookIncomeCents` is book net income computed exactly the way
 * the income-statement / M-1 route computes it. The four difference figures are the aggregated
 * permanent/temporary additions and subtractions from the M-1 reconciliation (all positive
 * magnitudes). `statutoryRatePct` is a percent, e.g. 21 for a 21% federal rate.
 */
export interface ProvisionInput {
  pretaxBookIncomeCents: number;
  statutoryRatePct: number;
  permanentAdditionsCents: number;
  permanentSubtractionsCents: number;
  temporaryAdditionsCents: number;
  temporarySubtractionsCents: number;
}

/** The fully-resolved ASC 740 provision. Every field is integer cents (deferred/total/effective
 *  may be negative) except the two percentages. */
export interface ProvisionResult {
  pretaxBookIncomeCents: number;
  statutoryRatePct: number;
  permanentNetCents: number;
  temporaryNetCents: number;
  taxableIncomeCents: number;
  /** Tax on this year's taxable income (payable). Negative = current benefit. */
  currentTaxCents: number;
  /** Deferred tax expense (+) or benefit (−) = Δ DTL − Δ DTA. */
  deferredTaxCents: number;
  /** The reported income-tax expense = current + deferred. */
  totalProvisionCents: number;
  /** Increase in the Deferred Tax ASSET from deductible temporary differences. */
  dtaChangeCents: number;
  /** Increase in the Deferred Tax LIABILITY from taxable temporary differences. */
  dtlChangeCents: number;
  /** Net deferred tax asset position change (Δ DTA − Δ DTL). */
  netDeferredTaxAssetCents: number;
  // ── Effective-rate reconciliation ──
  /** Tax at the statutory rate on pretax book income. */
  statutoryTaxCents: number;
  /** Tax effect of permanent differences (= total provision − statutory tax); the only
   *  reconciling item between statutory and effective rate here. */
  permanentTaxEffectCents: number;
  /** Effective tax rate = total provision / pretax book income (percent, 4 dp). 0 when
   *  pretax is 0 (undefined ratio). */
  effectiveRatePct: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// The computation (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Apply a percentage rate to an integer-cent amount, rounded to the nearest cent. */
function applyRate(cents: number, ratePct: number): number {
  return Math.round((cents * ratePct) / 100);
}

/**
 * Compute the ASC 740 income-tax provision (current + deferred) deterministically from book
 * net income, a statutory rate, and the M-1 permanent/temporary split.
 *
 * The deferred pieces (Δ DTA, Δ DTL) are each rounded independently, and both `deferredTaxCents`
 * and `totalProvisionCents` are DERIVED from those already-rounded pieces — so the provision JE
 * built from this result is guaranteed to balance to the cent regardless of rounding.
 */
export function computeProvision(input: ProvisionInput): ProvisionResult {
  const rate = input.statutoryRatePct;
  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error(`Invalid statutory rate: ${input.statutoryRatePct}`);
  }
  const pretax = Math.round(input.pretaxBookIncomeCents);
  const permAdd = Math.max(0, Math.round(input.permanentAdditionsCents));
  const permSub = Math.max(0, Math.round(input.permanentSubtractionsCents));
  const tempAdd = Math.max(0, Math.round(input.temporaryAdditionsCents));
  const tempSub = Math.max(0, Math.round(input.temporarySubtractionsCents));

  const permanentNetCents = permAdd - permSub;
  const temporaryNetCents = tempAdd - tempSub;
  const taxableIncomeCents = pretax + permanentNetCents + temporaryNetCents;

  const currentTaxCents = applyRate(taxableIncomeCents, rate);
  const dtaChangeCents = applyRate(tempAdd, rate);
  const dtlChangeCents = applyRate(tempSub, rate);
  // Deferred tax expense increases when a DTL is recorded, decreases (a benefit) when a DTA is.
  const deferredTaxCents = dtlChangeCents - dtaChangeCents;
  const totalProvisionCents = currentTaxCents + deferredTaxCents;

  const statutoryTaxCents = applyRate(pretax, rate);
  const permanentTaxEffectCents = totalProvisionCents - statutoryTaxCents;
  const effectiveRatePct =
    pretax !== 0 ? Math.round((totalProvisionCents / pretax) * 1_000_000) / 10_000 : 0;

  return {
    pretaxBookIncomeCents: pretax,
    statutoryRatePct: rate,
    permanentNetCents,
    temporaryNetCents,
    taxableIncomeCents,
    currentTaxCents,
    deferredTaxCents,
    totalProvisionCents,
    dtaChangeCents,
    dtlChangeCents,
    netDeferredTaxAssetCents: dtaChangeCents - dtlChangeCents,
    statutoryTaxCents,
    permanentTaxEffectCents,
    effectiveRatePct,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The provision journal entry (pure builder)
// ─────────────────────────────────────────────────────────────────────────────

/** Resolved account ids for the four provision postings. The payable / DTA / DTL ids are only
 *  required when their component is non-zero; the builder throws if a needed id is missing. */
export interface ProvisionAccountIds {
  incomeTaxExpenseAccountId: string;
  incomeTaxesPayableAccountId?: string | null;
  deferredTaxAssetAccountId?: string | null;
  deferredTaxLiabilityAccountId?: string | null;
}

/**
 * Build the balanced provision journal entry lines. Four economic components, each emitted only
 * when non-zero:
 *
 *   Income Tax Expense (P&L)         DR total provision      (CR if a net benefit)
 *   Income Taxes Payable (liab.)     CR current tax          (DR if a current benefit)
 *   Deferred Tax Asset (asset)       DR Δ DTA
 *   Deferred Tax Liability (liab.)   CR Δ DTL
 *
 * The four signed (debit-positive) amounts sum to exactly zero by construction
 * (total = current + Δ DTL − Δ DTA), so the entry always balances. Amounts are placed on the
 * natural side for a positive provision and flipped for a benefit.
 */
export function buildProvisionJournalLines(
  result: ProvisionResult,
  accounts: ProvisionAccountIds,
  locationId: string,
  memo?: string,
): JournalEntryLineInput[] {
  const line = (accountId: string, signedDebit: number): JournalEntryLineInput => ({
    account_id: accountId,
    debit_cents: signedDebit >= 0 ? signedDebit : 0,
    credit_cents: signedDebit < 0 ? -signedDebit : 0,
    location_id: locationId,
    memo,
  });

  const lines: JournalEntryLineInput[] = [];

  // Income tax expense — debit-positive by the total provision.
  if (result.totalProvisionCents !== 0) {
    lines.push(line(accounts.incomeTaxExpenseAccountId, result.totalProvisionCents));
  }
  // Income taxes payable — a liability credit is negative debit-positive.
  if (result.currentTaxCents !== 0) {
    if (!accounts.incomeTaxesPayableAccountId) {
      throw new Error('Income Taxes Payable account is required to post the current provision.');
    }
    lines.push(line(accounts.incomeTaxesPayableAccountId, -result.currentTaxCents));
  }
  // Deferred tax asset — debit-positive by the DTA increase.
  if (result.dtaChangeCents !== 0) {
    if (!accounts.deferredTaxAssetAccountId) {
      throw new Error('Deferred Tax Asset account is required to post the deferred provision.');
    }
    lines.push(line(accounts.deferredTaxAssetAccountId, result.dtaChangeCents));
  }
  // Deferred tax liability — a liability credit is negative debit-positive.
  if (result.dtlChangeCents !== 0) {
    if (!accounts.deferredTaxLiabilityAccountId) {
      throw new Error('Deferred Tax Liability account is required to post the deferred provision.');
    }
    lines.push(line(accounts.deferredTaxLiabilityAccountId, -result.dtlChangeCents));
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Effective-rate reconciliation rows (presentation-friendly, still pure)
// ─────────────────────────────────────────────────────────────────────────────

export interface EffectiveRateRow {
  label: string;
  amountCents: number;
  /** Contribution to the effective rate, in percentage points (4 dp). */
  ratePct: number;
}

/**
 * The standard rate-reconciliation ladder: statutory tax → permanent-difference effect →
 * total provision, with each row's contribution to the effective rate. Ties to the cent
 * because `permanentTaxEffectCents` is derived from the total.
 */
export function effectiveRateReconciliation(result: ProvisionResult): EffectiveRateRow[] {
  const pretax = result.pretaxBookIncomeCents;
  const asPct = (cents: number) =>
    pretax !== 0 ? Math.round((cents / pretax) * 1_000_000) / 10_000 : 0;
  return [
    { label: 'Tax at statutory rate', amountCents: result.statutoryTaxCents, ratePct: pretax !== 0 ? result.statutoryRatePct : 0 },
    { label: 'Effect of permanent differences', amountCents: result.permanentTaxEffectCents, ratePct: asPct(result.permanentTaxEffectCents) },
    { label: 'Total income tax provision', amountCents: result.totalProvisionCents, ratePct: result.effectiveRatePct },
  ];
}
