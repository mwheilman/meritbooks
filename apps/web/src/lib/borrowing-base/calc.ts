/**
 * Borrowing-base calculator — pure, deterministic, unit-tested. NO AI, NO I/O.
 *
 * A lender advances against eligible collateral. This module turns two collateral
 * datasets the app already maintains — open AR (per-invoice, from `v_ar_aging`) and
 * on-hand inventory value (from the stock-valuation engine) — into a classic
 * borrowing-base certificate: gross → ineligibles → eligible → advance rate →
 * availability, with a concentration analysis a controller could hand to a bank.
 *
 * Money is bigint CENTS end-to-end (CANON-ANCHOR §2 — never floats). Advance-rate
 * and concentration-cap products are rounded to whole cents with Math.round exactly
 * once, at the point they are taken, so the certificate reconciles to the cent.
 *
 * Design notes / honesty about what the data supports:
 *  - "Over-cutoff past due" (default 90 days) is computed from each invoice's due
 *    date vs the as-of date — the cutoff is a caller-supplied parameter, so the
 *    view's fixed 90+ bucket is NOT relied on.
 *  - "Cross-age taint" (a customer with ANY invoice past the cutoff has its ENTIRE
 *    balance made ineligible) is an OPTIONAL toggle — a real covenant many lenders
 *    impose. Off by default (only the directly-past-due dollars are carved out).
 *  - "Concentration cap": no single customer may contribute more than a % of the
 *    eligible AR pool; the excess is carved out. Single-pass on the post-past-due
 *    pool (standard, deterministic).
 *  - Foreign / affiliate ineligibles are NOT modelled — the customer record here
 *    carries no reliable country/affiliate flag, so inventing one would be a
 *    mockup. Documented as a future carve-out, not silently faked.
 */

/** One open AR invoice as the calculator consumes it. Balance is bigint cents. */
export interface ArInvoiceInput {
  customerId: string;
  customerName: string;
  balanceCents: number;
  /** ISO date (YYYY-MM-DD) or null (treated as not-yet-due → current). */
  dueDate: string | null;
}

export interface BorrowingBaseInputs {
  arInvoices: ArInvoiceInput[];
  /** On-hand inventory value at cost (bigint cents). */
  inventoryValueCents: number;
  /** As-of date (YYYY-MM-DD) used for days-past-due. Defaults to today. */
  asOf?: string;
}

export interface BorrowingBaseParams {
  /** AR advance rate, 0..1 (default 0.80). */
  arAdvanceRate: number;
  /** Inventory advance rate, 0..1 (default 0.50). */
  inventoryAdvanceRate: number;
  /** Days past due at which an invoice becomes ineligible (default 90). */
  agingCutoffDays: number;
  /**
   * Concentration cap, 0..1 — the max share of eligible AR one customer may hold
   * before the excess is carved out. 0 disables the cap (default 0.20).
   */
  concentrationCapPct: number;
  /**
   * Cross-age taint: if true, a customer with ANY invoice past the cutoff has its
   * WHOLE balance made ineligible (default false).
   */
  crossAgeTaint: boolean;
  /** Cap on eligible-inventory availability (bigint cents), or null for none. */
  inventorySublimitCents: number | null;
  /** Facility / commitment limit (bigint cents), or null for none. */
  facilityLimitCents: number | null;
  /** Currently-drawn loan balance (bigint cents), subtracted from availability. */
  outstandingCents: number;
}

export interface CustomerConcentration {
  customerId: string;
  customerName: string;
  /** Gross open balance for this customer. */
  totalCents: number;
  /** Portion carved out for being past the aging cutoff (incl. cross-age taint). */
  pastDueIneligibleCents: number;
  /** Portion carved out by the concentration cap. */
  concentrationExcessCents: number;
  /** Final eligible AR contributed by this customer. */
  eligibleCents: number;
  /** Share of total eligible AR, 0..1 (0 when eligible AR is 0). */
  pctOfEligible: number;
  /** True when this customer has ≥1 invoice past the cutoff. */
  hasPastDue: boolean;
}

export interface BorrowingBaseResult {
  // ── Accounts-receivable collateral ──
  grossArCents: number;
  arPastDueIneligibleCents: number;
  /** Extra ineligible created purely by the cross-age taint rule (0 when off). */
  arCrossAgeIneligibleCents: number;
  arConcentrationIneligibleCents: number;
  eligibleArCents: number;
  arAdvanceRate: number;
  arAvailabilityCents: number;

  // ── Inventory collateral ──
  inventoryValueCents: number;
  inventoryAdvanceRate: number;
  /** Inventory availability before the sublimit is applied. */
  inventoryUncappedAvailabilityCents: number;
  inventorySublimitCents: number | null;
  /** Amount trimmed by the inventory sublimit (0 when none / not binding). */
  inventorySublimitAppliedCents: number;
  inventoryAvailabilityCents: number;

  // ── Combined ──
  borrowingBaseCents: number;
  facilityLimitCents: number | null;
  /** Amount trimmed because the base exceeded the facility limit (0 when none). */
  facilityCapAppliedCents: number;
  /** min(borrowingBase, facilityLimit). */
  cappedBaseCents: number;
  outstandingCents: number;
  /** max(0, cappedBase − outstanding) — the floor at 0 is deliberate. */
  availabilityCents: number;

  // ── Concentration analysis (Rule-2 lender concern) ──
  customers: CustomerConcentration[];
  topCustomer: { customerName: string; pctOfEligible: number; eligibleCents: number } | null;
  /** True when the top customer exceeds the concentration cap threshold. */
  concentrationFlag: boolean;

  // Echoed parameters (so the certificate is self-describing).
  agingCutoffDays: number;
  concentrationCapPct: number;
  crossAgeTaint: boolean;
  asOf: string;
}

export const DEFAULT_PARAMS: BorrowingBaseParams = {
  arAdvanceRate: 0.8,
  inventoryAdvanceRate: 0.5,
  agingCutoffDays: 90,
  concentrationCapPct: 0.2,
  crossAgeTaint: false,
  inventorySublimitCents: null,
  facilityLimitCents: null,
  outstandingCents: 0,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function nonNegInt(n: number | null | undefined): number {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

function nonNegOrNull(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.round(v));
}

/** Whole days from `dueDate` to `asOf` (positive = past due). null due date → 0. */
export function daysPastDue(dueDate: string | null, asOf: string): number {
  if (!dueDate) return 0;
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const ref = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(ref)) return 0;
  return Math.floor((ref - due) / DAY_MS);
}

/**
 * PURE. Compute the borrowing base and availability from collateral inputs and
 * lender parameters. All amounts returned are whole bigint cents.
 */
export function computeBorrowingBase(
  inputs: BorrowingBaseInputs,
  params: Partial<BorrowingBaseParams> = {},
): BorrowingBaseResult {
  const p: BorrowingBaseParams = { ...DEFAULT_PARAMS, ...params };
  const arAdvanceRate = clamp01(p.arAdvanceRate);
  const inventoryAdvanceRate = clamp01(p.inventoryAdvanceRate);
  const concentrationCapPct = clamp01(p.concentrationCapPct);
  const cutoff = Number.isFinite(p.agingCutoffDays) ? Math.max(0, Math.floor(p.agingCutoffDays)) : 90;
  const crossAgeTaint = !!p.crossAgeTaint;
  const inventorySublimitCents = nonNegOrNull(p.inventorySublimitCents);
  const facilityLimitCents = nonNegOrNull(p.facilityLimitCents);
  const outstandingCents = nonNegInt(p.outstandingCents);
  const asOf = inputs.asOf && /^\d{4}-\d{2}-\d{2}$/.test(inputs.asOf)
    ? inputs.asOf
    : new Date().toISOString().slice(0, 10);
  const inventoryValueCents = nonNegInt(inputs.inventoryValueCents);

  // ── 1. Aggregate AR per customer, splitting past-cutoff from current ──────────
  interface Agg {
    customerId: string;
    customerName: string;
    totalCents: number;
    pastDueDirectCents: number; // dollars on invoices themselves past the cutoff
    hasPastDue: boolean;
  }
  const byCustomer = new Map<string, Agg>();
  let grossArCents = 0;

  for (const inv of inputs.arInvoices ?? []) {
    const bal = Math.round(Number(inv.balanceCents ?? 0));
    if (!Number.isFinite(bal) || bal === 0) continue;
    grossArCents += bal;
    const key = inv.customerId || inv.customerName || '__unknown__';
    const agg = byCustomer.get(key) ?? {
      customerId: inv.customerId || key,
      customerName: inv.customerName || 'Unknown customer',
      totalCents: 0,
      pastDueDirectCents: 0,
      hasPastDue: false,
    };
    agg.totalCents += bal;
    const overdue = daysPastDue(inv.dueDate, asOf) > cutoff;
    if (overdue) {
      agg.pastDueDirectCents += bal;
      agg.hasPastDue = true;
    }
    byCustomer.set(key, agg);
  }

  // ── 2. Past-due ineligible (+ optional cross-age taint) ───────────────────────
  let arPastDueIneligibleCents = 0;
  let arCrossAgeIneligibleCents = 0;
  interface Stage {
    agg: Agg;
    pastDueIneligibleCents: number;
    eligibleAfterPastDue: number;
  }
  const staged: Stage[] = [];
  for (const agg of byCustomer.values()) {
    // With taint on, a tainted customer's WHOLE balance is ineligible; the extra
    // beyond the directly-past-due dollars is the "cross-age" amount.
    const pastDueIneligibleCents = crossAgeTaint && agg.hasPastDue ? agg.totalCents : agg.pastDueDirectCents;
    arPastDueIneligibleCents += pastDueIneligibleCents;
    arCrossAgeIneligibleCents += Math.max(0, pastDueIneligibleCents - agg.pastDueDirectCents);
    staged.push({ agg, pastDueIneligibleCents, eligibleAfterPastDue: agg.totalCents - pastDueIneligibleCents });
  }

  // ── 3. Concentration cap (single pass on the post-past-due pool) ──────────────
  const poolCents = staged.reduce((s, x) => s + x.eligibleAfterPastDue, 0);
  const capCents = concentrationCapPct > 0 ? Math.round(concentrationCapPct * poolCents) : null;

  let arConcentrationIneligibleCents = 0;
  const customers: CustomerConcentration[] = staged.map((x) => {
    const concentrationExcessCents =
      capCents !== null ? Math.max(0, x.eligibleAfterPastDue - capCents) : 0;
    arConcentrationIneligibleCents += concentrationExcessCents;
    const eligibleCents = x.eligibleAfterPastDue - concentrationExcessCents;
    return {
      customerId: x.agg.customerId,
      customerName: x.agg.customerName,
      totalCents: x.agg.totalCents,
      pastDueIneligibleCents: x.pastDueIneligibleCents,
      concentrationExcessCents,
      eligibleCents,
      pctOfEligible: 0, // filled after eligible total known
      hasPastDue: x.agg.hasPastDue,
    };
  });

  const eligibleArCents = customers.reduce((s, c) => s + c.eligibleCents, 0);
  for (const c of customers) {
    c.pctOfEligible = eligibleArCents > 0 ? c.eligibleCents / eligibleArCents : 0;
  }
  customers.sort((a, b) => b.eligibleCents - a.eligibleCents || a.customerName.localeCompare(b.customerName));

  const arAvailabilityCents = Math.round(eligibleArCents * arAdvanceRate);

  // ── 4. Inventory availability (advance rate then sublimit) ────────────────────
  const inventoryUncappedAvailabilityCents = Math.round(inventoryValueCents * inventoryAdvanceRate);
  const inventoryAvailabilityCents =
    inventorySublimitCents !== null
      ? Math.min(inventoryUncappedAvailabilityCents, inventorySublimitCents)
      : inventoryUncappedAvailabilityCents;
  const inventorySublimitAppliedCents = inventoryUncappedAvailabilityCents - inventoryAvailabilityCents;

  // ── 5. Combine → cap at facility → floor availability at 0 ────────────────────
  const borrowingBaseCents = arAvailabilityCents + inventoryAvailabilityCents;
  const cappedBaseCents =
    facilityLimitCents !== null ? Math.min(borrowingBaseCents, facilityLimitCents) : borrowingBaseCents;
  const facilityCapAppliedCents = borrowingBaseCents - cappedBaseCents;
  const availabilityCents = Math.max(0, cappedBaseCents - outstandingCents);

  // ── 6. Concentration flag ─────────────────────────────────────────────────────
  const topCustomer = customers.length
    ? {
        customerName: customers[0].customerName,
        pctOfEligible: customers[0].pctOfEligible,
        eligibleCents: customers[0].eligibleCents,
      }
    : null;
  const concentrationFlag =
    !!topCustomer && concentrationCapPct > 0 && topCustomer.pctOfEligible > concentrationCapPct + 1e-9;

  return {
    grossArCents,
    arPastDueIneligibleCents,
    arCrossAgeIneligibleCents,
    arConcentrationIneligibleCents,
    eligibleArCents,
    arAdvanceRate,
    arAvailabilityCents,

    inventoryValueCents,
    inventoryAdvanceRate,
    inventoryUncappedAvailabilityCents,
    inventorySublimitCents,
    inventorySublimitAppliedCents,
    inventoryAvailabilityCents,

    borrowingBaseCents,
    facilityLimitCents,
    facilityCapAppliedCents,
    cappedBaseCents,
    outstandingCents,
    availabilityCents,

    customers,
    topCustomer,
    concentrationFlag,

    agingCutoffDays: cutoff,
    concentrationCapPct,
    crossAgeTaint,
    asOf,
  };
}
