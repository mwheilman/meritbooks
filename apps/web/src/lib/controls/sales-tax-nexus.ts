/**
 * Financial Control Exception EC-7 — Sales/use-tax economic-nexus tripwire.
 *
 * The six-figure undisclosed liability that surfaces in diligence and kills deals:
 * a seller crosses a state's economic-nexus threshold (post-Wayfair), keeps selling
 * into that state, and never registers or collects tax. The uncollected tax is a
 * liability the SELLER eats — it can't be retro-billed to customers — plus penalty
 * and interest, accruing silently for years. QuickBooks/Sage don't watch for this
 * without a bolt-on (Avalara); the owned ledger can, because it already holds every
 * invoice with a destination.
 *
 * This control NEVER registers, files, posts, or moves money (canon §3, FPB EC-7:
 * "never auto-registers"). It DETECTS the crossing from real invoice history and
 * DRAFTS the next step (register + start collecting; commission a nexus study /
 * consider a VDA for the back-period exposure) for a human with the right role to
 * act on.
 *
 * Signal: aggregate trailing-12-month invoiced revenue AND transaction (invoice)
 * count by DESTINATION STATE, then flag any state that has crossed a tunable
 * per-state economic-nexus threshold (default $100,000 in sales OR 200 transactions
 * in the window). There is no registration table yet (NEEDS CENTRAL — see below), so
 * every threshold-crossing state is surfaced as a *candidate* exposure and the
 * exception says so explicitly; a human confirms whether the entity is already
 * registered/collecting there.
 *
 * Destination state resolution (most-defensible-wins, per invoice):
 *   invoice.ship_to->>'state'  (true destination — the correct nexus basis)
 *     else invoice.bill_to->>'state'
 *     else the customer's core.customers.state (HQ fallback — lower confidence).
 * The ship_to/bill_to snapshots are known-sparse (FPB flag), so the customer-state
 * fallback carries most tenants today; the share carried by fallback is tracked and
 * DISCOUNTS confidence (an HQ address may not be where goods shipped).
 *
 * How it reaches the queue WITHOUT touching the /exceptions aggregator: each crossed
 * state is written as a PROPOSED row in public.ai_decisions with feature
 * 'SALES_TAX_NEXUS'. The existing /exceptions route already folds PROPOSED
 * ai_decisions in as an `ai_proposal` source. This mirrors EC-1/2/3/4/10 exactly —
 * no aggregator change, no schema change, no new table.
 *
 * Idempotency: each crossing carries a stable `dedup_key` (`nexus:<STATE>:<YYYY-MM
 * window>`, the window identified by its ending month) in proposed_output, so a
 * re-scan UPDATES the open exception rather than duplicating it (migration 070 makes
 * the DB the guarantor: one open PROPOSED row per (org, feature, dedup_key)), leaves
 * human-resolved (APPROVED/REJECTED) rows untouched, and EXPIRES rows whose window
 * has rolled past (queue hygiene).
 *
 * Tiering: EC-7 is fundamentally an ESCALATE control (existential-$), but per the
 * anti-cry-wolf design it enters at REVIEW and ESCALATEs when the exposure is well
 * over threshold (≥2× the sales/txn threshold) or sustained across the window
 * (sales in most of the 12 months — a persistent nexus, not a one-off spike).
 *
 * The pure aggregation + threshold + tier + confidence math (`normalizeState`,
 * `aggregateByState`, `thresholdFor`, `crossedThreshold`, `resolveNexusTier`,
 * `nexusConfidence`, period helpers) is I/O-free and unit-tested. `scanSalesTaxNexus`
 * does the RLS-scoped reads/writes and never throws — a control must not break the
 * pass it rides on.
 *
 * All money is bigint cents. Accounts are not touched (this control drafts a filing
 * action, not a JE). RLS enforces org isolation; the scan never hand-filters org_id.
 *
 * ── NEEDS CENTRAL (data the schema is missing) ────────────────────────────────
 *   1. A tenant-maintained sales-tax REGISTRATION table (state, registered_at,
 *      collecting flag) so a crossed-but-registered state can be auto-suppressed.
 *      Absent today → every crossing is surfaced as a *candidate* and the human
 *      confirms registration. See `REGISTRATION_STATUS`.
 *   2. A maintained per-state ECONOMIC-NEXUS THRESHOLD table (the law changes; a few
 *      states use sales-only or higher $ thresholds). `STATE_THRESHOLD_OVERRIDES`
 *      below is a small, documented SEED for the most-cited variants; the rest fall
 *      to the $100k/200-txn default. This belongs in central reference data with a
 *      maintenance owner, not hard-coded in a control.
 *   3. Optional but higher-fidelity: a destination address on the invoice LINE / a
 *      denormalized `invoices.ship_state` column (the jsonb snapshots are sparse),
 *      and payroll-by-state + inventory (3PL/FBA) locations for *income/franchise*
 *      nexus (FPB EC-7 second signal — out of scope here, sales/use only).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAction } from '@/lib/trust/action-log';
import { getTierPolicy, scoreToTier, type Tier, type TierPolicy } from '@/lib/trust/score-tier';
import {
  loadAutonomyGovernance,
  decideDisposition,
  type AutonomyGovernance,
} from '@/lib/autonomy/disposition';
import { fetchCoreMap } from '@/lib/stitch-core';
import { formatMoney } from '@meritbooks/shared';

export const SALES_TAX_NEXUS_FEATURE = 'SALES_TAX_NEXUS';

/** Where an invoice's destination state was resolved from (drives confidence). */
export type StateSource = 'ship_to' | 'bill_to' | 'customer';

// ── Tunable model (single source of truth; kept here so it can't drift) ─────────

/** A per-state economic-nexus threshold. `salesCents` and/or `txnCount` may be null. */
export interface NexusThreshold {
  /** trailing-window sales $ that trips nexus (cents); null = no $ trigger. */
  salesCents: number | null;
  /** trailing-window transaction count that trips nexus; null = no count trigger. */
  txnCount: number | null;
}

/** The default most states use post-Wayfair: $100,000 in sales OR 200 transactions. */
export const DEFAULT_NEXUS_THRESHOLD: NexusThreshold = {
  salesCents: 100_000_00, // $100,000 in cents
  txnCount: 200,
};

/**
 * SEED overrides for the most-cited states that differ from the default. This is a
 * documented starting point, NOT a substitute for maintained legal reference data
 * (NEEDS CENTRAL #2). The widely-cited large-market states use a $500,000 sales-only
 * threshold (no transaction count). Keep this list conservative; when unsure, the
 * $100k/200 default is the safe (earlier-tripping) posture for a *tripwire*.
 */
export const STATE_THRESHOLD_OVERRIDES: Record<string, NexusThreshold> = {
  CA: { salesCents: 500_000_00, txnCount: null }, // California — $500k, no count
  TX: { salesCents: 500_000_00, txnCount: null }, // Texas — $500k, no count
  NY: { salesCents: 500_000_00, txnCount: 100 }, // New York — $500k AND 100 txns
};

export const NEXUS_TUNABLES = {
  /** trailing window length in months (rolling). */
  windowMonths: 12,
  /** ESCALATE when sales/txns reach this multiple of the threshold ("well over"). */
  escalateMultiple: 2,
  /** ESCALATE when the state had sales in at least this many months of the window. */
  escalatePersistenceMonths: 9,
  /** surface (in the summary only, not queued) states at/above this share of threshold. */
  approachingRatio: 0.8,
  /** detection confidence when the crossing rests on true destination (ship/bill). */
  confidenceBase: 0.9,
  /** confidence floor once the customer-HQ fallback share is discounted. */
  confidenceFloor: 0.7,
  /** how hard a 100%-fallback state is discounted from base toward floor. */
  fallbackPenalty: 0.2,
  /** cap invoice ids persisted per exception (jsonb size guard). */
  maxSubjectsPerBucket: 250,
} as const;

/**
 * No registration table exists yet (NEEDS CENTRAL #1). Every crossing is surfaced as
 * a CANDIDATE and the human confirms whether the entity already collects there.
 */
export const REGISTRATION_STATUS = 'UNKNOWN_NO_REGISTRY' as const;

/** Invoice statuses that represent a real, consummated sale (exclude DRAFT/VOIDED). */
const SALE_STATUSES = ['SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WRITTEN_OFF'];

// ─────────────────────────────────────────────────────────────────────────────
// Period math (pure). Periods are 'YYYY-MM'; an "index" is months since year 0.
// ─────────────────────────────────────────────────────────────────────────────

export function periodOf(dateISO: string | null | undefined): string | null {
  if (!dateISO) return null;
  const s = String(dateISO);
  if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function periodToIndex(period: string | null | undefined): number | null {
  if (!period || !/^\d{4}-\d{2}$/.test(period)) return null;
  const [y, m] = period.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  return y * 12 + (m - 1);
}

export function indexToPeriod(idx: number): string {
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function addPeriods(period: string, n: number): string | null {
  const idx = periodToIndex(period);
  return idx == null ? null : indexToPeriod(idx + n);
}

/** Clamp a 0..1 confidence into the numeric(5,4) range the DB column accepts. */
export function toConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}

/** Deterministic, stable dedup key: nexus:<STATE>:<YYYY-MM window-end>. */
export function dedupKey(state: string, windowEndPeriod: string): string {
  return `nexus:${state}:${windowEndPeriod}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// State normalization (pure). Accepts a 2-letter code or a full state name and
// returns the canonical 2-letter code, or null when it isn't a US state/DC.
// ─────────────────────────────────────────────────────────────────────────────

const STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);

const STATE_NAME_TO_CODE: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC',
  FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL',
  INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA',
  MAINE: 'ME', MARYLAND: 'MD', MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN',
  MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK',
  OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
  VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI',
  WYOMING: 'WY',
};

/** Canonical 2-letter US state code from a raw code/name, or null if not a state. */
export function normalizeState(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (s.length === 0) return null;
  if (s.length === 2 && STATE_CODES.has(s)) return s;
  return STATE_NAME_TO_CODE[s] ?? null;
}

/** The economic-nexus threshold for a state (override or the default). */
export function thresholdFor(state: string): NexusThreshold {
  return STATE_THRESHOLD_OVERRIDES[state] ?? DEFAULT_NEXUS_THRESHOLD;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation (pure, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

/** One invoice reduced to what nexus math needs. */
export interface NexusInvoice {
  invoiceId: string;
  state: string | null; // already normalized (or null → undestined, excluded)
  source: StateSource | null;
  salesCents: number;
  period: string | null; // 'YYYY-MM'
  locationId?: string | null;
}

export interface StateAggregate {
  state: string;
  salesCents: number;
  txnCount: number;
  /** sales cents whose state came from the customer-HQ fallback (lower confidence). */
  fallbackSalesCents: number;
  /** distinct 'YYYY-MM' periods in which this state had sales (persistence signal). */
  monthsWithSales: number;
  invoiceIds: string[];
  /** modal location among this state's invoices (for the exception's location_id). */
  locationId: string | null;
}

/**
 * Group invoices by destination state. Invoices with no resolvable state are dropped
 * (an undestined sale can't be attributed to a nexus). Pure — no I/O, no clock.
 */
export function aggregateByState(invoices: NexusInvoice[]): Map<string, StateAggregate> {
  const byState = new Map<
    string,
    {
      salesCents: number;
      txnCount: number;
      fallbackSalesCents: number;
      months: Set<string>;
      invoiceIds: string[];
      locCount: Map<string, number>;
    }
  >();

  for (const inv of invoices) {
    if (!inv.state) continue;
    const sales = Math.max(0, Math.round(Number(inv.salesCents) || 0));
    const g =
      byState.get(inv.state) ??
      {
        salesCents: 0,
        txnCount: 0,
        fallbackSalesCents: 0,
        months: new Set<string>(),
        invoiceIds: [] as string[],
        locCount: new Map<string, number>(),
      };
    g.salesCents += sales;
    g.txnCount += 1;
    if (inv.source === 'customer') g.fallbackSalesCents += sales;
    if (inv.period) g.months.add(inv.period);
    g.invoiceIds.push(inv.invoiceId);
    if (inv.locationId) g.locCount.set(inv.locationId, (g.locCount.get(inv.locationId) ?? 0) + 1);
    byState.set(inv.state, g);
  }

  const out = new Map<string, StateAggregate>();
  for (const [state, g] of byState) {
    let locationId: string | null = null;
    let best = 0;
    for (const [loc, c] of g.locCount) {
      if (c > best) {
        best = c;
        locationId = loc;
      }
    }
    out.set(state, {
      state,
      salesCents: g.salesCents,
      txnCount: g.txnCount,
      fallbackSalesCents: g.fallbackSalesCents,
      monthsWithSales: g.months.size,
      invoiceIds: g.invoiceIds,
      locationId,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Threshold + confidence + tier (pure, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

export interface CrossingResult {
  crossed: boolean;
  /** how the threshold was tripped (may be both). */
  basis: Array<'sales' | 'transactions'>;
  /** sales / txn as a fraction of their thresholds (for "approaching" + tiering). */
  salesRatio: number; // 0..∞ (0 when the state has no $ threshold)
  txnRatio: number; // 0..∞ (0 when the state has no count threshold)
}

/** Has this state crossed its economic-nexus threshold? Pure. */
export function crossedThreshold(agg: StateAggregate, threshold: NexusThreshold): CrossingResult {
  const basis: Array<'sales' | 'transactions'> = [];
  const salesRatio =
    threshold.salesCents && threshold.salesCents > 0 ? agg.salesCents / threshold.salesCents : 0;
  const txnRatio = threshold.txnCount && threshold.txnCount > 0 ? agg.txnCount / threshold.txnCount : 0;
  if (threshold.salesCents != null && agg.salesCents >= threshold.salesCents) basis.push('sales');
  if (threshold.txnCount != null && agg.txnCount >= threshold.txnCount) basis.push('transactions');
  return { crossed: basis.length > 0, basis, salesRatio, txnRatio };
}

/**
 * Detection confidence (0..1) that a crossing is a real, actionable nexus exposure.
 * The arithmetic is certain; the uncertainty is DESTINATION — a crossing resting on
 * customer-HQ fallback (rather than a true ship-to/bill-to) may misattribute the
 * state, so it is discounted toward the floor by its fallback share. Pure.
 */
export function nexusConfidence(
  agg: StateAggregate,
  tunables: typeof NEXUS_TUNABLES = NEXUS_TUNABLES,
): number {
  const total = agg.salesCents;
  const fallbackShare = total > 0 ? Math.max(0, Math.min(1, agg.fallbackSalesCents / total)) : 1;
  const raw = tunables.confidenceBase - tunables.fallbackPenalty * fallbackShare;
  return Math.max(tunables.confidenceFloor, Math.min(tunables.confidenceBase, raw));
}

/**
 * EC-7 tier. Existential-$ control: never AUTO. Enters at REVIEW; ESCALATEs when the
 * exposure is WELL OVER threshold (≥ escalateMultiple × either trigger) or SUSTAINED
 * across the window (sales in ≥ escalatePersistenceMonths of the 12 months — a
 * standing nexus, not a one-off spike). `scoreToTier` sets the confidence/amount
 * floor; we never drop below REVIEW and raise to ESCALATE per the rule. Pure.
 */
export function resolveNexusTier(
  agg: StateAggregate,
  crossing: CrossingResult,
  confidence: number,
  policy: TierPolicy,
  tunables: typeof NEXUS_TUNABLES = NEXUS_TUNABLES,
): Tier {
  const wellOver =
    crossing.salesRatio >= tunables.escalateMultiple || crossing.txnRatio >= tunables.escalateMultiple;
  const sustained = agg.monthsWithSales >= tunables.escalatePersistenceMonths;
  if (wellOver || sustained) return 'escalate';
  const { tier } = scoreToTier({ confidence, amountCents: agg.salesCents }, policy);
  return tier === 'auto' ? 'review' : tier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan orchestration (I/O — RLS-scoped; never throws)
// ─────────────────────────────────────────────────────────────────────────────

export interface NexusBucket {
  dedupKey: string;
  state: string;
  locationId: string | null;
  windowStart: string;
  windowEnd: string;
  salesCents: number;
  txnCount: number;
  threshold: NexusThreshold;
  basis: Array<'sales' | 'transactions'>;
  monthsWithSales: number;
  fallbackShare: number;
  confidence: number; // 0..1 pre-clamp
  tier: Tier;
  title: string;
  reason: string;
  question: string;
  invoiceIds: string[];
}

export interface NexusScanSummary {
  window: { start: string; end: string; months: number };
  scanned: { invoices: number; statesWithSales: number };
  crossed: number;
  approaching: Array<{ state: string; salesCents: number; txnCount: number; pctOfThreshold: number }>;
  byTier: Record<Tier, number>;
  queued: number;
  refreshed: number;
  expired: number;
  totalExposureSalesCents: number;
  errors: number;
  findings: Array<{
    state: string;
    salesCents: number;
    txnCount: number;
    tier: Tier;
    basis: Array<'sales' | 'transactions'>;
    title: string;
  }>;
}

export interface NexusScanOptions {
  /** injectable clock for deterministic tests; defaults to now. */
  asOfISO?: string;
  /** window-end month ('YYYY-MM'); defaults to the month of asOf. */
  windowEnd?: string;
  /** compute + return the crossings WITHOUT persisting any exception rows. */
  dryRun?: boolean;
}

interface InvoiceRow {
  id: string;
  customer_id: string | null;
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

/**
 * Scan the ledger for EC-7 sales-tax economic-nexus crossings over the trailing
 * window, queue / refresh the exceptions into /exceptions (PROPOSED ai_decisions,
 * feature 'SALES_TAX_NEXUS'), and return a summary. Never throws. Reads/writes run
 * through the RLS-scoped client; org isolation is enforced by the database.
 */
export async function scanSalesTaxNexus(
  supabase: SupabaseClient,
  orgId: string,
  opts: NexusScanOptions = {},
): Promise<NexusScanSummary> {
  const asOfISO = opts.asOfISO ?? new Date().toISOString();
  const windowEnd = opts.windowEnd ?? periodOf(asOfISO) ?? indexToPeriod(0);
  const windowStart = addPeriods(windowEnd, -(NEXUS_TUNABLES.windowMonths - 1)) ?? windowEnd;
  const startIdx = periodToIndex(windowStart);
  const endIdx = periodToIndex(windowEnd);

  const summary: NexusScanSummary = {
    window: { start: windowStart, end: windowEnd, months: NEXUS_TUNABLES.windowMonths },
    scanned: { invoices: 0, statesWithSales: 0 },
    crossed: 0,
    approaching: [],
    byTier: { auto: 0, review: 0, escalate: 0 },
    queued: 0,
    refreshed: 0,
    expired: 0,
    totalExposureSalesCents: 0,
    errors: 0,
    findings: [],
  };

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(supabase, orgId);
  } catch {
    policy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }

  // Autonomy Control Plane: kill-switch + per-feature dial, resolved once; the
  // ADVISORY disposition is recorded on each queued exception (detect-only).
  const gov: AutonomyGovernance = await loadAutonomyGovernance(
    supabase,
    orgId,
    SALES_TAX_NEXUS_FEATURE,
  );

  // ── Load invoices in the trailing window (real sales only) ──────────────────
  let rows: InvoiceRow[] = [];
  try {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, customer_id, location_id, invoice_date, subtotal_cents, tax_cents, total_cents, status, ship_to, bill_to')
      .in('status', SALE_STATUSES)
      .order('invoice_date', { ascending: true })
      .limit(20000);
    if (error) {
      console.warn('[controls/nexus] invoices load failed:', error.message);
      summary.errors += 1;
      return summary;
    }
    rows = (data ?? []) as InvoiceRow[];
  } catch (e) {
    console.warn('[controls/nexus] invoices load threw:', e instanceof Error ? e.message : e);
    summary.errors += 1;
    return summary;
  }

  // Keep only invoices dated inside the window.
  const inWindow = rows.filter((r) => {
    const idx = periodToIndex(periodOf(r.invoice_date));
    return idx != null && startIdx != null && endIdx != null && idx >= startIdx && idx <= endIdx;
  });
  summary.scanned.invoices = inWindow.length;

  // Resolve customer-state fallback for invoices lacking a ship/bill state.
  const customerIds = inWindow
    .filter((r) => !jsonState(r.ship_to) && !jsonState(r.bill_to))
    .map((r) => r.customer_id);
  const custMap = await fetchCoreMap<{ id: string; name: string | null; state: string | null }>(
    supabase,
    'customers',
    'id, name, state',
    customerIds,
  );

  // Reduce each invoice to a NexusInvoice (destination state + source + $ + period).
  const nexusInvoices: NexusInvoice[] = inWindow.map((r) => {
    const shipState = jsonState(r.ship_to);
    const billState = jsonState(r.bill_to);
    let state: string | null;
    let source: StateSource | null;
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
    return {
      invoiceId: r.id,
      state,
      source,
      salesCents: salesBasisCents(r),
      period: periodOf(r.invoice_date),
      locationId: r.location_id,
    };
  });

  const byState = aggregateByState(nexusInvoices);
  summary.scanned.statesWithSales = byState.size;

  // ── Evaluate each state against its threshold ───────────────────────────────
  const buckets: NexusBucket[] = [];
  for (const [state, agg] of byState) {
    const threshold = thresholdFor(state);
    const crossing = crossedThreshold(agg, threshold);

    if (!crossing.crossed) {
      // Track "approaching" states for the summary (not queued) — early warning.
      const pct = Math.max(crossing.salesRatio, crossing.txnRatio);
      if (pct >= NEXUS_TUNABLES.approachingRatio) {
        summary.approaching.push({
          state,
          salesCents: agg.salesCents,
          txnCount: agg.txnCount,
          pctOfThreshold: Math.round(pct * 100) / 100,
        });
      }
      continue;
    }

    const confidence = nexusConfidence(agg);
    const tier = resolveNexusTier(agg, crossing, confidence, policy);
    const fallbackShare = agg.salesCents > 0 ? agg.fallbackSalesCents / agg.salesCents : 1;

    const thresholdWord =
      threshold.salesCents != null && threshold.txnCount != null
        ? `${formatMoney(threshold.salesCents)} in sales or ${threshold.txnCount} transactions`
        : threshold.salesCents != null
          ? `${formatMoney(threshold.salesCents)} in sales`
          : `${threshold.txnCount} transactions`;
    const basisWord = crossing.basis
      .map((b) => (b === 'sales' ? `${formatMoney(agg.salesCents)} in sales` : `${agg.txnCount} transactions`))
      .join(' and ');
    const fallbackNote =
      fallbackShare > 0
        ? ` (${Math.round(fallbackShare * 100)}% of this state's revenue was attributed by the customer's address, not an explicit ship-to — verify the true destination).`
        : '';

    const title = `${state} — economic-nexus threshold crossed · ${formatMoney(agg.salesCents)} / ${agg.txnCount} txns (trailing 12mo)`;
    const reason =
      `In the trailing 12 months (${windowStart}–${windowEnd}) the entity invoiced ${formatMoney(agg.salesCents)} across ` +
      `${agg.txnCount} transactions destined for ${state}, crossing that state's economic-nexus threshold (${thresholdWord}) on ${basisWord}. ` +
      `Sales occurred in ${agg.monthsWithSales} of the last 12 months.${fallbackNote} ` +
      `There is no registration record for ${state} in the book of record (registration status: ${REGISTRATION_STATUS}), so this is a CANDIDATE undisclosed sales/use-tax exposure: ` +
      `if the entity is not already registered and collecting there, uncollected tax + penalty + interest is accruing — a liability the seller eats (it cannot be retro-billed). ` +
      `Next step (draft): register for sales/use tax in ${state} and begin collecting; commission a nexus study and consider a Voluntary Disclosure Agreement for the back-period exposure. This control never auto-registers or files.`;
    const question =
      `Is the entity already registered and collecting sales/use tax in ${state}? If not, register + begin collecting and assess the back-period exposure (VDA); if it already collects there, confirm to dismiss.`;

    buckets.push({
      dedupKey: dedupKey(state, windowEnd),
      state,
      locationId: agg.locationId,
      windowStart,
      windowEnd,
      salesCents: agg.salesCents,
      txnCount: agg.txnCount,
      threshold,
      basis: crossing.basis,
      monthsWithSales: agg.monthsWithSales,
      fallbackShare,
      confidence,
      tier,
      title,
      reason,
      question,
      invoiceIds: agg.invoiceIds.slice(0, NEXUS_TUNABLES.maxSubjectsPerBucket),
    });
  }

  // Highest $-exposure first — the biggest liability surfaces at the top.
  buckets.sort((a, b) => b.salesCents - a.salesCents);
  summary.approaching.sort((a, b) => b.pctOfThreshold - a.pctOfThreshold);
  summary.crossed = buckets.length;
  for (const b of buckets) {
    summary.totalExposureSalesCents += b.salesCents;
    summary.findings.push({
      state: b.state,
      salesCents: b.salesCents,
      txnCount: b.txnCount,
      tier: b.tier,
      basis: b.basis,
      title: b.title,
    });
  }

  if (opts.dryRun) return summary;

  // ── Idempotency: load existing SALES_TAX_NEXUS rows keyed by dedup_key ───────
  const existing = new Map<string, { id: string; status: string }>();
  try {
    const { data } = await supabase
      .from('ai_decisions')
      .select('id, status, proposed_output')
      .eq('feature', SALES_TAX_NEXUS_FEATURE)
      .in('status', ['PROPOSED', 'APPROVED', 'REJECTED']);
    for (const row of data ?? []) {
      const r = row as { id: string; status: string; proposed_output?: { dedup_key?: string } };
      const key = r.proposed_output?.dedup_key;
      if (key) existing.set(key, { id: r.id, status: r.status });
    }
  } catch {
    /* best-effort — worst case we re-queue rather than refresh */
  }

  const liveKeys = new Set(buckets.map((b) => b.dedupKey));

  for (const b of buckets) {
    const confidence = toConfidence(b.confidence);
    const { disposition } = decideDisposition({
      killSwitchEngaged: gov.killSwitchEngaged,
      setting: gov.setting,
      scoreTier: b.tier,
      amountCents: b.salesCents,
    });
    const proposedOutput = {
      control: 'EC-7',
      dedup_key: b.dedupKey,
      state: b.state,
      window: { start: b.windowStart, end: b.windowEnd, months: NEXUS_TUNABLES.windowMonths },
      trailing_sales_cents: b.salesCents,
      trailing_txn_count: b.txnCount,
      threshold: { sales_cents: b.threshold.salesCents, txn_count: b.threshold.txnCount },
      basis_crossed: b.basis,
      months_with_sales: b.monthsWithSales,
      customer_fallback_share: Math.round(b.fallbackShare * 100) / 100,
      registration_status: REGISTRATION_STATUS,
      tier: b.tier,
      disposition,
      subject_table: 'invoices',
      subject_ids: b.invoiceIds,
      remediation: {
        type: 'NEXUS_STUDY',
        auto_apply: false,
        next_step:
          `Register for sales/use tax in ${b.state} and begin collecting; commission a nexus study and consider a VDA for the back-period exposure.`,
        note: 'Draft only — this control never registers, files, or collects tax. A human decides register / VDA / taxability analysis (canon §3, FPB EC-7).',
      },
      reason: b.reason,
    };

    const prior = existing.get(b.dedupKey);
    // A human already dispositioned this crossing — do not resurface it.
    if (prior && (prior.status === 'APPROVED' || prior.status === 'REJECTED')) continue;

    if (prior && prior.status === 'PROPOSED') {
      const { error } = await supabase
        .from('ai_decisions')
        .update({
          input_summary: b.title,
          proposed_output: proposedOutput,
          confidence,
          reasoning: b.reason,
          clarifying_question: b.question,
        })
        .eq('id', prior.id);
      if (error) {
        console.warn('[controls/nexus] refresh failed:', error.message);
        summary.errors += 1;
        continue;
      }
      summary.refreshed += 1;
      summary.byTier[b.tier] += 1;
      continue;
    }

    const { error } = await supabase.from('ai_decisions').insert({
      org_id: orgId,
      location_id: b.locationId,
      feature: SALES_TAX_NEXUS_FEATURE,
      input_summary: b.title,
      proposed_output: proposedOutput,
      confidence,
      reasoning: b.reason,
      clarifying_question: b.question,
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      console.warn('[controls/nexus] could not queue exception:', error.message);
      summary.errors += 1;
      continue;
    }
    summary.queued += 1;
    summary.byTier[b.tier] += 1;

    // Trust audit trail — the AI's detection, actor = AI (canon §3 / FPB D7).
    await logAction(supabase, {
      orgId,
      actorType: 'AI',
      actorUserId: null,
      action: 'controls.sales_tax_nexus.detect',
      subjectTable: 'invoices',
      subjectId: null,
      summary: b.title,
      locationId: b.locationId,
      confidence,
      tier: b.tier,
      metadata: {
        dedup_key: b.dedupKey,
        state: b.state,
        window_end: b.windowEnd,
        trailing_sales_cents: b.salesCents,
        trailing_txn_count: b.txnCount,
        basis_crossed: b.basis,
      },
    });
  }

  // ── Expire previously-open crossings whose window has rolled past (hygiene) ──
  for (const [key, prior] of existing) {
    if (prior.status !== 'PROPOSED' || liveKeys.has(key)) continue;
    const { error } = await supabase
      .from('ai_decisions')
      .update({ status: 'EXPIRED' })
      .eq('id', prior.id)
      .eq('status', 'PROPOSED');
    if (!error) summary.expired += 1;
  }

  return summary;
}
