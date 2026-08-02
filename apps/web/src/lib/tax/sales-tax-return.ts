/**
 * Sales/use-tax RETURN PREP — pure aggregation + reconciliation engine.
 *
 * This is the "what do I actually owe, and to whom" companion to the EC-7
 * economic-nexus TRIPWIRE (`lib/controls/sales-tax-nexus.ts`). EC-7 answers
 * "where SHOULD I be registered?"; this answers "for the states I collect in,
 * what is the filing-ready liability THIS period, and does it tie to the books?"
 *
 * The output is a per-jurisdiction worksheet a bookkeeper hands to their filer
 * (or types into a state portal): gross sales, taxable sales, exempt sales, tax
 * collected, and a RATE RECONCILIATION (tax collected vs the tax the taxable
 * base implies at the expected rate) — plus a GL TIE-OUT that reconciles the
 * worksheet's total collected tax to the net credits posted to the Sales Tax
 * Payable liability account over the same window, and to that account's balance.
 *
 * DESIGN INVARIANTS (canon):
 *   • Pure & deterministic: everything in THIS file is I/O-free and unit-tested.
 *     The RLS-scoped reads/GL tie-out live in the assembler (`sales-tax-return-report.ts`).
 *   • All money is bigint cents. No floats for money. Rates are percentages
 *     (numeric), used only to DERIVE a cents figure that is then compared.
 *   • Read-only: this never registers, files, posts, or moves money. It reports.
 *   • Jurisdiction resolution mirrors EC-7 exactly (ship_to → bill_to → customer
 *     HQ), so the two tax surfaces can never disagree on where a sale landed —
 *     we import `normalizeState`/`periodOf` from the control rather than re-derive.
 *
 * Taxability classification (per invoice, most-specific-wins):
 *   • EXEMPT     — the customer is flagged `tax_exempt` (resale/nonprofit/govt).
 *   • TAXABLE    — tax was actually charged (tax_cents > 0).
 *   • NON_TAXABLE— no tax charged and customer not exempt (out-of-scope sale,
 *     e.g. a service the state doesn't tax, or a not-yet-collecting jurisdiction).
 *   For the RETURN, taxable = TAXABLE base; exempt column = EXEMPT + NON_TAXABLE
 *   (both are "non-taxed sales" a return reports as deductions from gross), with
 *   the two broken out so a preparer can see genuinely-exempt vs simply-untaxed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeState, periodOf } from '@/lib/controls/sales-tax-nexus';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import { fetchCoreMap } from '@/lib/stitch-core';

export { normalizeState, periodOf };

// ── Tunables (single source of truth; kept here so they can't drift) ────────────
export const SALES_TAX_TUNABLES = {
  /** Absolute rounding slack for a "reconciled" rate/GL tie-out (cents). */
  toleranceCents: 100, // $1.00 — swallows penny rounding across many invoices
  /** Relative slack for the rate reconciliation as a share of the taxable base. */
  toleranceRatio: 0.005, // 0.5%
  /** Cap invoice ids retained per jurisdiction (payload-size guard). */
  maxInvoiceIdsPerJurisdiction: 500,
} as const;

export type Taxability = 'TAXABLE' | 'EXEMPT' | 'NON_TAXABLE';

/** One invoice reduced to what the return math needs. Built by the assembler. */
export interface ReturnInvoice {
  invoiceId: string;
  invoiceNumber: string | null;
  /** normalized destination state (2-letter) or null → unattributed, excluded. */
  state: string | null;
  /** where `state` came from (drives the customer-HQ fallback disclosure). */
  source: 'ship_to' | 'bill_to' | 'customer' | null;
  /** optional finer jurisdiction label (city/county) from the job, if present. */
  localJurisdiction: string | null;
  /** pre-tax revenue basis (subtotal). Never negative. */
  grossSalesCents: number;
  /** sales tax actually charged/collected on the invoice. */
  taxCents: number;
  /** the customer is tax-exempt (resale/nonprofit/govt). */
  customerExempt: boolean;
  /** expected statutory rate for this sale (%, e.g. 7.0) if known, else null. */
  expectedRatePct: number | null;
  /** 'YYYY-MM' the sale falls in. */
  period: string | null;
}

/** Classify a sale for the return. Pure. */
export function classifySale(inv: Pick<ReturnInvoice, 'customerExempt' | 'taxCents'>): Taxability {
  if (inv.customerExempt) return 'EXEMPT';
  if ((Number(inv.taxCents) || 0) > 0) return 'TAXABLE';
  return 'NON_TAXABLE';
}

/** Aggregated liability for one jurisdiction (state). All money is cents. */
export interface JurisdictionAggregate {
  jurisdiction: string; // 2-letter state code
  grossSalesCents: number; // all sales destined here (pre-tax)
  taxableSalesCents: number; // base that was taxed
  exemptSalesCents: number; // customer-exempt base
  nonTaxableSalesCents: number; // untaxed, not customer-exempt
  taxCollectedCents: number; // tax actually charged
  /** taxable base for which an expected statutory rate was known (rate-recon basis). */
  ratedSalesCents: number;
  /** tax the RATED base implies at its expected rate(s) (cents). */
  expectedTaxCents: number;
  txnCount: number;
  taxableTxnCount: number;
  exemptTxnCount: number;
  /** taxable-base cents whose state rests on the customer-HQ fallback (lower trust). */
  fallbackSalesCents: number;
  /** distinct local jurisdiction labels observed within the state (display only). */
  localJurisdictions: string[];
  invoiceIds: string[];
}

/**
 * Group invoices by destination state, splitting taxable / exempt / non-taxable
 * and accumulating the rate-reconciliation basis. Invoices with no resolvable
 * state are dropped (an unattributed sale can't be filed to any jurisdiction).
 * Pure — no I/O, no clock.
 */
export function aggregateByJurisdiction(invoices: ReturnInvoice[]): Map<string, JurisdictionAggregate> {
  const acc = new Map<
    string,
    {
      grossSalesCents: number;
      taxableSalesCents: number;
      exemptSalesCents: number;
      nonTaxableSalesCents: number;
      taxCollectedCents: number;
      ratedSalesCents: number;
      expectedTaxCents: number;
      txnCount: number;
      taxableTxnCount: number;
      exemptTxnCount: number;
      fallbackSalesCents: number;
      locals: Set<string>;
      invoiceIds: string[];
    }
  >();

  for (const inv of invoices) {
    if (!inv.state) continue;
    const gross = Math.max(0, Math.round(Number(inv.grossSalesCents) || 0));
    const tax = Math.max(0, Math.round(Number(inv.taxCents) || 0));
    const klass = classifySale(inv);

    const g =
      acc.get(inv.state) ??
      {
        grossSalesCents: 0,
        taxableSalesCents: 0,
        exemptSalesCents: 0,
        nonTaxableSalesCents: 0,
        taxCollectedCents: 0,
        ratedSalesCents: 0,
        expectedTaxCents: 0,
        txnCount: 0,
        taxableTxnCount: 0,
        exemptTxnCount: 0,
        fallbackSalesCents: 0,
        locals: new Set<string>(),
        invoiceIds: [] as string[],
      };

    g.grossSalesCents += gross;
    g.taxCollectedCents += tax;
    g.txnCount += 1;

    if (klass === 'TAXABLE') {
      g.taxableSalesCents += gross;
      g.taxableTxnCount += 1;
      if (inv.source === 'customer') g.fallbackSalesCents += gross;
      if (inv.expectedRatePct != null && Number.isFinite(inv.expectedRatePct) && inv.expectedRatePct > 0) {
        g.ratedSalesCents += gross;
        // Derive the expected tax in cents (round once, per invoice).
        g.expectedTaxCents += Math.round((gross * inv.expectedRatePct) / 100);
      }
    } else if (klass === 'EXEMPT') {
      g.exemptSalesCents += gross;
      g.exemptTxnCount += 1;
    } else {
      g.nonTaxableSalesCents += gross;
    }

    if (inv.localJurisdiction && inv.localJurisdiction.trim()) g.locals.add(inv.localJurisdiction.trim());
    g.invoiceIds.push(inv.invoiceId);
    acc.set(inv.state, g);
  }

  const out = new Map<string, JurisdictionAggregate>();
  for (const [state, g] of acc) {
    out.set(state, {
      jurisdiction: state,
      grossSalesCents: g.grossSalesCents,
      taxableSalesCents: g.taxableSalesCents,
      exemptSalesCents: g.exemptSalesCents,
      nonTaxableSalesCents: g.nonTaxableSalesCents,
      taxCollectedCents: g.taxCollectedCents,
      ratedSalesCents: g.ratedSalesCents,
      expectedTaxCents: g.expectedTaxCents,
      txnCount: g.txnCount,
      taxableTxnCount: g.taxableTxnCount,
      exemptTxnCount: g.exemptTxnCount,
      fallbackSalesCents: g.fallbackSalesCents,
      localJurisdictions: Array.from(g.locals).sort(),
      invoiceIds: g.invoiceIds.slice(0, SALES_TAX_TUNABLES.maxInvoiceIdsPerJurisdiction),
    });
  }
  return out;
}

/** Effective rate (%) actually realized = tax collected / taxable base. Pure. */
export function effectiveRatePct(agg: Pick<JurisdictionAggregate, 'taxCollectedCents' | 'taxableSalesCents'>): number {
  if (agg.taxableSalesCents <= 0) return 0;
  return Math.round((agg.taxCollectedCents / agg.taxableSalesCents) * 100 * 1000) / 1000;
}

export interface RateReconciliation {
  /** tax the RATED taxable base implies at its expected rate (cents). */
  expectedTaxCents: number;
  /** collected − expected, over the rated base (positive = over-collected). */
  varianceCents: number;
  /** the effective realized rate on the whole taxable base (%). */
  effectiveRatePct: number;
  /** the expected rate on the rated base (%), or null when no rate was known. */
  expectedRatePct: number | null;
  /** true when the rated base carried a known expected rate to compare against. */
  hasExpectedRate: boolean;
  /** true when |variance| exceeds the greater of the absolute/relative tolerance. */
  flagged: boolean;
}

/**
 * Reconcile collected tax to what the taxable base SHOULD have produced at the
 * expected statutory rate. When no expected rate is known for any taxable sale
 * (`ratedSalesCents === 0`), we can't judge over/under-collection, so `flagged`
 * is false and `hasExpectedRate` is false — the worksheet simply shows the
 * effective rate for the preparer's eyes. Pure.
 */
export function reconcileRate(
  agg: Pick<
    JurisdictionAggregate,
    'taxCollectedCents' | 'taxableSalesCents' | 'ratedSalesCents' | 'expectedTaxCents'
  >,
  tunables: typeof SALES_TAX_TUNABLES = SALES_TAX_TUNABLES,
): RateReconciliation {
  const eff = effectiveRatePct(agg);
  const hasExpectedRate = agg.ratedSalesCents > 0;

  if (!hasExpectedRate) {
    return {
      expectedTaxCents: 0,
      varianceCents: 0,
      effectiveRatePct: eff,
      expectedRatePct: null,
      hasExpectedRate: false,
      flagged: false,
    };
  }

  // Compare only over the RATED share of the taxable base (apples-to-apples): the
  // collected tax attributable to rated sales is prorated by rated / taxable.
  const ratedShare = agg.taxableSalesCents > 0 ? agg.ratedSalesCents / agg.taxableSalesCents : 1;
  const collectedOnRated = Math.round(agg.taxCollectedCents * ratedShare);
  const varianceCents = collectedOnRated - agg.expectedTaxCents;

  const expectedRatePct = Math.round((agg.expectedTaxCents / agg.ratedSalesCents) * 100 * 1000) / 1000;
  const tol = Math.max(tunables.toleranceCents, Math.round(agg.ratedSalesCents * tunables.toleranceRatio));
  const flagged = Math.abs(varianceCents) > tol;

  return {
    expectedTaxCents: agg.expectedTaxCents,
    varianceCents,
    effectiveRatePct: eff,
    expectedRatePct,
    hasExpectedRate: true,
    flagged,
  };
}

export interface GlReconciliation {
  /** total sales tax collected per the invoice worksheet (cents). */
  worksheetTaxCents: number;
  /** net credits to Sales Tax Payable over the window (credits − debits, cents). */
  glNetCreditCents: number;
  /** worksheet − GL (positive = worksheet exceeds what the ledger accrued). */
  varianceCents: number;
  /** true when |variance| within tolerance. */
  reconciled: boolean;
}

/**
 * Tie the worksheet's total collected tax to the Sales Tax Payable account's net
 * credit activity over the same window. A clean tie means every invoice's tax
 * leg posted; a variance flags an unposted invoice, a manual JE to the account,
 * or a remittance that landed inside the window. Pure. Money in cents.
 */
export function reconcileToGl(
  worksheetTaxCents: number,
  glNetCreditCents: number,
  tunables: typeof SALES_TAX_TUNABLES = SALES_TAX_TUNABLES,
): GlReconciliation {
  const w = Math.round(Number(worksheetTaxCents) || 0);
  const g = Math.round(Number(glNetCreditCents) || 0);
  const varianceCents = w - g;
  return {
    worksheetTaxCents: w,
    glNetCreditCents: g,
    varianceCents,
    reconciled: Math.abs(varianceCents) <= tunables.toleranceCents,
  };
}

/** A filing-ready line for one jurisdiction, everything a preparer needs. */
export interface JurisdictionReturnLine {
  jurisdiction: string;
  grossSalesCents: number;
  taxableSalesCents: number;
  exemptSalesCents: number;
  nonTaxableSalesCents: number;
  /** exempt + non-taxable — the total non-taxed deduction from gross. */
  deductionsCents: number;
  taxCollectedCents: number;
  txnCount: number;
  taxableTxnCount: number;
  exemptTxnCount: number;
  effectiveRatePct: number;
  expectedRatePct: number | null;
  expectedTaxCents: number;
  rateVarianceCents: number;
  rateFlagged: boolean;
  hasExpectedRate: boolean;
  /** share (0..1) of taxable base whose state came from the customer-HQ fallback. */
  fallbackShare: number;
  localJurisdictions: string[];
  invoiceIds: string[];
}

/** Build one filing line from a jurisdiction aggregate. Pure. */
export function buildReturnLine(
  agg: JurisdictionAggregate,
  tunables: typeof SALES_TAX_TUNABLES = SALES_TAX_TUNABLES,
): JurisdictionReturnLine {
  const rate = reconcileRate(agg, tunables);
  const fallbackShare = agg.taxableSalesCents > 0 ? agg.fallbackSalesCents / agg.taxableSalesCents : 0;
  return {
    jurisdiction: agg.jurisdiction,
    grossSalesCents: agg.grossSalesCents,
    taxableSalesCents: agg.taxableSalesCents,
    exemptSalesCents: agg.exemptSalesCents,
    nonTaxableSalesCents: agg.nonTaxableSalesCents,
    deductionsCents: agg.exemptSalesCents + agg.nonTaxableSalesCents,
    taxCollectedCents: agg.taxCollectedCents,
    txnCount: agg.txnCount,
    taxableTxnCount: agg.taxableTxnCount,
    exemptTxnCount: agg.exemptTxnCount,
    effectiveRatePct: rate.effectiveRatePct,
    expectedRatePct: rate.expectedRatePct,
    expectedTaxCents: rate.expectedTaxCents,
    rateVarianceCents: rate.varianceCents,
    rateFlagged: rate.flagged,
    hasExpectedRate: rate.hasExpectedRate,
    fallbackShare: Math.round(fallbackShare * 10000) / 10000,
    localJurisdictions: agg.localJurisdictions,
    invoiceIds: agg.invoiceIds,
  };
}

export interface ReturnTotals {
  grossSalesCents: number;
  taxableSalesCents: number;
  exemptSalesCents: number;
  nonTaxableSalesCents: number;
  deductionsCents: number;
  taxCollectedCents: number;
  txnCount: number;
  jurisdictionCount: number;
  /** jurisdictions whose rate reconciliation is flagged. */
  rateFlaggedCount: number;
}

/**
 * The complete worksheet: sorted per-jurisdiction lines (largest liability first)
 * and the roll-up totals. Optionally filtered to a single jurisdiction. Pure.
 */
export function buildWorksheet(
  invoices: ReturnInvoice[],
  opts: { jurisdiction?: string | null; tunables?: typeof SALES_TAX_TUNABLES } = {},
): { lines: JurisdictionReturnLine[]; totals: ReturnTotals } {
  const tunables = opts.tunables ?? SALES_TAX_TUNABLES;
  const filterState = opts.jurisdiction ? normalizeState(opts.jurisdiction) : null;

  const byState = aggregateByJurisdiction(invoices);
  const lines: JurisdictionReturnLine[] = [];
  for (const [state, agg] of byState) {
    if (filterState && state !== filterState) continue;
    lines.push(buildReturnLine(agg, tunables));
  }
  // Largest tax liability first — the biggest filing surfaces at the top.
  lines.sort((a, b) => b.taxCollectedCents - a.taxCollectedCents || a.jurisdiction.localeCompare(b.jurisdiction));

  const totals: ReturnTotals = {
    grossSalesCents: 0,
    taxableSalesCents: 0,
    exemptSalesCents: 0,
    nonTaxableSalesCents: 0,
    deductionsCents: 0,
    taxCollectedCents: 0,
    txnCount: 0,
    jurisdictionCount: lines.length,
    rateFlaggedCount: 0,
  };
  for (const l of lines) {
    totals.grossSalesCents += l.grossSalesCents;
    totals.taxableSalesCents += l.taxableSalesCents;
    totals.exemptSalesCents += l.exemptSalesCents;
    totals.nonTaxableSalesCents += l.nonTaxableSalesCents;
    totals.deductionsCents += l.deductionsCents;
    totals.taxCollectedCents += l.taxCollectedCents;
    totals.txnCount += l.txnCount;
    if (l.rateFlagged) totals.rateFlaggedCount += 1;
  }
  return { lines, totals };
}

// ═════════════════════════════════════════════════════════════════════════════
// Assembler (I/O — RLS-scoped). Everything above is pure and unit-tested; the
// arithmetic never touches the database and the reads never hand-filter org_id
// (RLS enforces isolation). Mirrors the EC-7 control's pure+I/O split in one file.
// ═════════════════════════════════════════════════════════════════════════════

/** Invoice statuses that represent a real, consummated sale (exclude DRAFT/VOIDED). */
const SALE_STATUSES = ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WRITTEN_OFF'];

interface InvoiceRow {
  id: string;
  invoice_number: string | null;
  customer_id: string | null;
  job_id: string | null;
  location_id: string | null;
  invoice_date: string | null;
  subtotal_cents: number | string | null;
  tax_cents: number | string | null;
  total_cents: number | string | null;
  status: string | null;
  ship_to: Record<string, unknown> | null;
  bill_to: Record<string, unknown> | null;
}

/** Gross taxable-sales basis for an invoice: pre-tax revenue (subtotal), or total−tax. */
function salesBasisCents(row: InvoiceRow): number {
  const sub = Number(row.subtotal_cents) || 0;
  if (sub > 0) return sub;
  const total = Number(row.total_cents) || 0;
  const tax = Number(row.tax_cents) || 0;
  return Math.max(0, total - tax);
}

function jsonState(snapshot: Record<string, unknown> | null): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return normalizeState(snapshot['state'] ?? snapshot['region'] ?? null);
}

export interface SalesTaxReturnOptions {
  startDate: string; // YYYY-MM-DD inclusive
  endDate: string; // YYYY-MM-DD inclusive
  /** restrict the DISPLAYED lines to one state (GL tie-out stays org-wide). */
  jurisdiction?: string | null;
  /** restrict to one entity/location (both the worksheet AND the GL tie-out). */
  locationId?: string | null;
}

export interface GlTieOut extends GlReconciliation {
  /** whether the Sales Tax Payable account resolved (else the tie-out is N/A). */
  available: boolean;
  accountNumber: string | null;
  /** credits to the payable account sourced from AR (invoice) postings, in window. */
  arCreditCents: number;
  /** debits to the payable account in window (remittances / adjustments). */
  remittanceDebitCents: number;
  /** all-time net credit balance of the payable account as of endDate (what's owed). */
  endingBalanceCents: number;
  note: string | null;
}

export interface NexusAlert {
  state: string;
  /** trailing-12mo destined sales that tripped EC-7 (cents), if present. */
  trailingSalesCents: number | null;
  tier: string | null;
  /** is the entity collecting tax in this state in the return window? */
  collectingNow: boolean;
  /** collect-you-should-but-you-aren't — the actionable exposure. */
  shouldCollectNotCollecting: boolean;
}

export interface SalesTaxReturnReport {
  window: { startDate: string; endDate: string };
  jurisdictionFilter: string | null;
  locationFilter: string | null;
  worksheet: { lines: JurisdictionReturnLine[]; totals: ReturnTotals };
  /** totals across ALL jurisdictions (unfiltered) — the GL tie-out basis. */
  allJurisdictionTotals: ReturnTotals;
  glTieOut: GlTieOut;
  nexusAlerts: NexusAlert[];
  meta: {
    invoicesScanned: number;
    invoicesAttributed: number;
    invoicesUnattributed: number;
    /** share (0..1) of taxable base attributed by customer-HQ fallback. */
    fallbackShare: number;
    generatedAt: string;
  };
}

/**
 * Best-effort per-job tax attributes (rate / local jurisdiction). The columns
 * were added pre-core-carve and may not have followed jobs into `core`; a failed
 * lookup degrades to "no expected rate" rather than throwing. Read-only.
 */
async function loadJobTaxMap(
  supabase: SupabaseClient,
  jobIds: string[],
): Promise<Map<string, { tax_rate_pct: number | null; tax_jurisdiction: string | null; is_taxable: boolean | null }>> {
  const empty = new Map<string, { tax_rate_pct: number | null; tax_jurisdiction: string | null; is_taxable: boolean | null }>();
  const unique = Array.from(new Set(jobIds.filter((x): x is string => typeof x === 'string' && x.length > 0)));
  if (unique.length === 0) return empty;
  try {
    const { data, error } = await supabase
      .schema('core')
      .from('jobs')
      .select('id, tax_rate_pct, tax_jurisdiction, is_taxable')
      .in('id', unique);
    if (error || !data) return empty;
    for (const row of data as Array<{ id: string; tax_rate_pct: number | null; tax_jurisdiction: string | null; is_taxable: boolean | null }>) {
      if (row?.id) empty.set(row.id, { tax_rate_pct: row.tax_rate_pct, tax_jurisdiction: row.tax_jurisdiction, is_taxable: row.is_taxable });
    }
  } catch {
    /* column may not exist post-carve — degrade to no expected rate. */
  }
  return empty;
}

/**
 * Assemble the sales-tax return worksheet + GL tie-out + nexus cross-reference
 * for the caller's org over [startDate, endDate]. Read-only: never registers,
 * files, posts, or moves money. Never throws — a data gap degrades the affected
 * section rather than failing the report.
 */
export async function buildSalesTaxReturn(
  supabase: SupabaseClient,
  orgId: string,
  opts: SalesTaxReturnOptions,
): Promise<SalesTaxReturnReport> {
  const { startDate, endDate } = opts;
  const locationId = opts.locationId && opts.locationId !== 'all' ? opts.locationId : null;
  const jurisdiction = opts.jurisdiction && opts.jurisdiction !== 'all' ? opts.jurisdiction : null;

  // ── 1. Invoices in the window (real sales only) ──────────────────────────────
  let invQuery = supabase
    .from('invoices')
    .select('id, invoice_number, customer_id, job_id, location_id, invoice_date, subtotal_cents, tax_cents, total_cents, status, ship_to, bill_to')
    .in('status', SALE_STATUSES)
    .gte('invoice_date', startDate)
    .lte('invoice_date', endDate)
    .order('invoice_date', { ascending: true })
    .limit(20000);
  if (locationId) invQuery = invQuery.eq('location_id', locationId);

  let rows: InvoiceRow[] = [];
  try {
    const { data, error } = await invQuery;
    if (!error) rows = (data ?? []) as InvoiceRow[];
    else console.warn('[tax/sales-tax-return] invoice load failed:', error.message);
  } catch (e) {
    console.warn('[tax/sales-tax-return] invoice load threw:', e instanceof Error ? e.message : e);
  }

  // ── 2. Stitch customer (exempt + HQ state) and job (rate) attributes ─────────
  const custMap = await fetchCoreMap<{ id: string; state: string | null; tax_exempt: boolean | null }>(
    supabase,
    'customers',
    'id, state, tax_exempt',
    rows.map((r) => r.customer_id),
  );
  const jobMap = await loadJobTaxMap(supabase, rows.map((r) => r.job_id ?? ''));

  // ── 3. Reduce each invoice to a ReturnInvoice (destination + taxability) ─────
  let attributed = 0;
  const returnInvoices: ReturnInvoice[] = rows.map((r) => {
    const shipState = jsonState(r.ship_to);
    const billState = jsonState(r.bill_to);
    let state: string | null;
    let source: ReturnInvoice['source'];
    if (shipState) {
      state = shipState;
      source = 'ship_to';
    } else if (billState) {
      state = billState;
      source = 'bill_to';
    } else {
      state = r.customer_id ? normalizeState(custMap.get(r.customer_id)?.state ?? null) : null;
      source = state ? 'customer' : null;
    }
    if (state) attributed += 1;

    const job = r.job_id ? jobMap.get(r.job_id) : undefined;
    const expectedRatePct =
      job && job.is_taxable !== false && job.tax_rate_pct != null && Number(job.tax_rate_pct) > 0
        ? Number(job.tax_rate_pct)
        : null;

    return {
      invoiceId: r.id,
      invoiceNumber: r.invoice_number,
      state,
      source,
      localJurisdiction: job?.tax_jurisdiction ?? null,
      grossSalesCents: salesBasisCents(r),
      taxCents: Math.max(0, Number(r.tax_cents) || 0),
      customerExempt: r.customer_id ? custMap.get(r.customer_id)?.tax_exempt === true : false,
      expectedRatePct,
      period: periodOf(r.invoice_date),
    };
  });

  // Full (unfiltered) worksheet drives the GL tie-out; filtered drives display.
  const full = buildWorksheet(returnInvoices);
  const display = jurisdiction ? buildWorksheet(returnInvoices, { jurisdiction }) : full;

  const fallbackTaxable = full.lines.reduce((s, l) => s + l.fallbackShare * l.taxableSalesCents, 0);
  const fallbackShare = full.totals.taxableSalesCents > 0 ? fallbackTaxable / full.totals.taxableSalesCents : 0;

  // ── 4. GL tie-out to the Sales Tax Payable liability account ─────────────────
  const glTieOut = await buildGlTieOut(supabase, orgId, {
    startDate,
    endDate,
    locationId,
    worksheetTaxCents: full.totals.taxCollectedCents,
  });

  // ── 5. Nexus cross-reference (EC-7 open proposals) ───────────────────────────
  const collectingByState = new Set(full.lines.filter((l) => l.taxCollectedCents > 0).map((l) => l.jurisdiction));
  const nexusAlerts = await buildNexusAlerts(supabase, collectingByState);

  return {
    window: { startDate, endDate },
    jurisdictionFilter: jurisdiction ? normalizeState(jurisdiction) : null,
    locationFilter: locationId,
    worksheet: display,
    allJurisdictionTotals: full.totals,
    glTieOut,
    nexusAlerts,
    meta: {
      invoicesScanned: rows.length,
      invoicesAttributed: attributed,
      invoicesUnattributed: rows.length - attributed,
      fallbackShare: Math.round(fallbackShare * 10000) / 10000,
      generatedAt: new Date().toISOString(),
    },
  };
}

async function buildGlTieOut(
  supabase: SupabaseClient,
  orgId: string,
  args: { startDate: string; endDate: string; locationId: string | null; worksheetTaxCents: number },
): Promise<GlTieOut> {
  const base: GlTieOut = {
    ...reconcileToGl(args.worksheetTaxCents, 0),
    available: false,
    accountNumber: null,
    arCreditCents: 0,
    remittanceDebitCents: 0,
    endingBalanceCents: 0,
    note: null,
  };

  // Resolve the tenant's Sales Tax Payable account by ROLE (never a hard number).
  let account: { id: string; account_number: string };
  try {
    const ref = await resolveRole(supabase, orgId, 'SALES_TAX_PAYABLE');
    account = { id: ref.id, account_number: ref.account_number };
  } catch (e) {
    return {
      ...base,
      note:
        e instanceof PostingError
          ? 'Sales Tax Payable account is not mapped for this tenant — map it on Account Roles to enable the GL tie-out.'
          : 'Could not resolve the Sales Tax Payable account.',
    };
  }

  // Window activity on the payable account (POSTED only), split AR-sourced credits
  // (invoice accruals) from debits (remittances/adjustments).
  let windowCreditCents = 0;
  let windowDebitCents = 0;
  let arCreditCents = 0;
  try {
    let q = supabase
      .from('gl_entry_lines')
      .select('debit_cents, credit_cents, location_id, gl_entries!inner(entry_date, status, source_module)')
      .eq('account_id', account.id)
      .eq('gl_entries.status', 'POSTED')
      .gte('gl_entries.entry_date', args.startDate)
      .lte('gl_entries.entry_date', args.endDate)
      .limit(50000);
    if (args.locationId) q = q.eq('location_id', args.locationId);
    const { data, error } = await q;
    if (error) return { ...base, available: true, accountNumber: account.account_number, note: `GL activity query failed: ${error.message}` };
    for (const row of (data ?? []) as unknown as Array<{ debit_cents: number | null; credit_cents: number | null; gl_entries: { source_module: string | null } }>) {
      const d = Number(row.debit_cents) || 0;
      const c = Number(row.credit_cents) || 0;
      windowCreditCents += c;
      windowDebitCents += d;
      if ((row.gl_entries?.source_module ?? '') === 'AR') arCreditCents += c;
    }
  } catch (e) {
    return { ...base, available: true, accountNumber: account.account_number, note: e instanceof Error ? e.message : 'GL activity query threw' };
  }

  // Ending balance = all-time net credit (credits − debits) through endDate.
  let endingBalanceCents = 0;
  try {
    let q = supabase
      .from('gl_entry_lines')
      .select('debit_cents, credit_cents, location_id, gl_entries!inner(entry_date, status)')
      .eq('account_id', account.id)
      .eq('gl_entries.status', 'POSTED')
      .lte('gl_entries.entry_date', args.endDate)
      .limit(100000);
    if (args.locationId) q = q.eq('location_id', args.locationId);
    const { data } = await q;
    for (const row of (data ?? []) as unknown as Array<{ debit_cents: number | null; credit_cents: number | null }>) {
      endingBalanceCents += (Number(row.credit_cents) || 0) - (Number(row.debit_cents) || 0);
    }
  } catch {
    /* balance is context-only; leave 0 on failure. */
  }

  // Tie the worksheet's collected tax to the AR-sourced credits (the invoice
  // accruals) — the apples-to-apples comparison. Remittances are shown separately.
  const recon = reconcileToGl(args.worksheetTaxCents, arCreditCents);
  const windowNetCredit = windowCreditCents - windowDebitCents;
  return {
    ...recon,
    glNetCreditCents: windowNetCredit, // report net window activity for transparency
    available: true,
    accountNumber: account.account_number,
    arCreditCents,
    remittanceDebitCents: windowDebitCents,
    endingBalanceCents,
    note: recon.reconciled
      ? null
      : 'Worksheet collected tax does not match the invoice-sourced credits to Sales Tax Payable — check for unposted invoices or manual entries to the account.',
  };
}

async function buildNexusAlerts(supabase: SupabaseClient, collectingByState: Set<string>): Promise<NexusAlert[]> {
  const alerts: NexusAlert[] = [];
  try {
    const { data } = await supabase
      .from('ai_decisions')
      .select('proposed_output')
      .eq('feature', 'SALES_TAX_NEXUS')
      .eq('status', 'PROPOSED')
      .limit(200);
    for (const row of (data ?? []) as Array<{ proposed_output?: { state?: string; trailing_sales_cents?: number; tier?: string } }>) {
      const po = row.proposed_output;
      const state = po?.state ? normalizeState(po.state) : null;
      if (!state) continue;
      const collectingNow = collectingByState.has(state);
      alerts.push({
        state,
        trailingSalesCents: po?.trailing_sales_cents != null ? Number(po.trailing_sales_cents) : null,
        tier: po?.tier ?? null,
        collectingNow,
        shouldCollectNotCollecting: !collectingNow,
      });
    }
  } catch {
    /* nexus cross-ref is additive — absence degrades gracefully. */
  }
  // Deduplicate by state (keep the not-collecting/most-actionable variant).
  const byState = new Map<string, NexusAlert>();
  for (const a of alerts) {
    const prior = byState.get(a.state);
    if (!prior || (a.shouldCollectNotCollecting && !prior.shouldCollectNotCollecting)) byState.set(a.state, a);
  }
  return Array.from(byState.values()).sort(
    (a, b) => Number(b.shouldCollectNotCollecting) - Number(a.shouldCollectNotCollecting) || (b.trailingSalesCents ?? 0) - (a.trailingSalesCents ?? 0),
  );
}
