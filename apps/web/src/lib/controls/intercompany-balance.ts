/**
 * Financial Control Exception EC-3 — Intercompany / interdepartmental out-of-balance.
 *
 * A continuous control that reconciles the owned ledger's INTERNAL activity on a
 * cadence and surfaces $-quantified exceptions into the unified /exceptions queue.
 * It NEVER posts a correcting entry, books a mirror, or edits the ledger — it
 * DETECTS an imbalance and DRAFTS a remediation for a human to apply (canon §3:
 * AI proposes facts; the deterministic engine posts; a human approves). An
 * out-of-balance internal position blocks a clean consolidation and misstates
 * consolidated equity/EBITDA — so these are high-integrity, close-blocking checks.
 *
 * How it reaches the queue WITHOUT touching the aggregator: each hit is written as
 * a PROPOSED row in public.ai_decisions with feature 'INTERCOMPANY_IMBALANCE'. The
 * existing /exceptions route already folds PROPOSED ai_decisions in as an
 * `ai_proposal` source (input_summary → title, feature → subtitle, confidence →
 * bar). This mirrors EC-1 (duplicate-payments) and EC-10 (anomalous-je) exactly.
 *
 * THREE balance assertions (all per fiscal period; the scorers are I/O-free and
 * unit-tested):
 *
 *   (a) INTERDEPARTMENT balance — within EACH company (location), for each period,
 *       sum(is_eliminating REVENUE credit) must equal sum(is_eliminating COST
 *       debit). The internal-invoice engine (migration 015 / internal-invoices.ts)
 *       posts DR Interdept Services Cost (5990) / CR Interdept Services Revenue
 *       (4990); a cost-transfer invoice DRs and CRs the same 5991 account (net 0).
 *       A non-zero delta means one eliminating leg was booked to a non-eliminating
 *       account (or a manual JE hit one eliminating account only) — the interdept
 *       revenue and cost will NOT net to zero at the company roll-up.  → kind
 *       'interdept_imbalance'.
 *
 *   (b) INTERCOMPANY balance — across entities, for each period, the group's
 *       Intercompany Receivable (role INTERCOMPANY_AR / 1160, a debit-normal
 *       asset = "due-from") must equal its Intercompany Payable (role
 *       INTERCOMPANY_AP / 2020, a credit-normal liability = "due-to"). A residual
 *       (due-from ≠ due-to) is an intercompany pair that will not eliminate on
 *       consolidation.  → kind 'intercompany_imbalance'.
 *
 *   (c) ONE-SIDED internal invoice — an internal invoice marked 'booked' whose GL
 *       entry is missing (booked_gl_entry_id is null), OR a company/period where
 *       the revenue-method booked internal-invoice subledger total does not tie to
 *       the interdept revenue actually posted to the GL. Either way an internal
 *       invoice landed on one side of the books but not the other.  → kind
 *       'internal_invoice_onesided'.
 *
 * All money is bigint cents. Confidence is clamped into numeric(5,4). The scan is
 * idempotent: a `dedup_key` per (company/period/kind) means a re-scan never
 * double-queues the same exception, and an already-resolved (APPROVED/REJECTED)
 * one does not resurface.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAction } from '@/lib/trust/action-log';
import { getTierPolicy, scoreToTier, type Tier, type TierPolicy } from '@/lib/trust/score-tier';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import { formatMoney } from '@meritbooks/shared';

export const IC_FEATURE = 'INTERCOMPANY_IMBALANCE';

// ── Tunable thresholds (single source of truth; kept here so they can't drift) ──
export const IC_THRESHOLDS = {
  /**
   * Below this absolute delta (cents) an imbalance is treated as rounding noise
   * and never surfaced. Ledger money is exact integer cents, so 0 is defensible;
   * a 1-cent floor guards against a stray half-cent rounding somewhere upstream.
   */
  toleranceCents: 1,
  /** Deterministic-arithmetic confidence for a proven GL leg imbalance (a). */
  interdeptConfidence: 0.97,
  /** Deterministic-arithmetic confidence for a due-from ≠ due-to residual (b). */
  intercompanyConfidence: 0.96,
  /** A 'booked' invoice with NO GL entry is a certain one-sided post (c). */
  unbookedInvoiceConfidence: 0.98,
  /** Subledger-to-GL coverage drift with all invoices GL-linked (c). */
  coverageDriftConfidence: 0.9,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Clamp a 0..1 confidence into the numeric(5,4) range the DB column accepts. */
export function toConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}

/** `YYYY-MM` period key from an ISO date (the grouping key for a fiscal month). */
export function periodKeyOf(isoDate: string): string {
  return (isoDate || '').slice(0, 7);
}

/** `Mon YYYY` human label from a `YYYY-MM` period key. */
export function periodLabelOf(periodKey: string): string {
  const [y, m] = periodKey.split('-');
  const monthIdx = Number(m) - 1;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const mm = months[monthIdx] ?? m;
  return y ? `${mm} ${y}` : periodKey;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion (a) — interdepartment eliminating revenue == cost, per company/period
// ─────────────────────────────────────────────────────────────────────────────

export interface InterdeptPeriodInput {
  locationId: string;
  companyName: string;
  periodKey: string;
  /** Net credit on is_eliminating REVENUE accounts (revenue is credit-normal). */
  elimRevenueCents: number;
  /** Net debit on is_eliminating COGS/OPEX accounts (cost is debit-normal). */
  elimCostCents: number;
}

export interface BalanceSignal {
  /** Signed out-of-balance amount (cents); the exception's $-at-risk is its abs. */
  deltaCents: number;
  confidence: number; // 0..1 (pre-clamp)
  reason: string; // plain-language, audit-ready
}

/**
 * Assert interdept revenue ties to interdept cost within a company/period.
 * Returns null when in balance (within tolerance). A cost-transfer invoice books
 * DR+CR on the same eliminating account, so it nets to zero on BOTH sides and can
 * never trip this — only a genuinely one-legged eliminating post does.
 */
export function assessInterdeptBalance(input: InterdeptPeriodInput): BalanceSignal | null {
  const deltaCents = input.elimRevenueCents - input.elimCostCents;
  if (Math.abs(deltaCents) < IC_THRESHOLDS.toleranceCents) return null;
  const dir = deltaCents > 0 ? 'revenue exceeds cost' : 'cost exceeds revenue';
  return {
    deltaCents,
    confidence: IC_THRESHOLDS.interdeptConfidence,
    reason:
      `${input.companyName}: interdepartmental services revenue (${formatMoney(input.elimRevenueCents)}) ` +
      `does not equal interdepartmental services cost (${formatMoney(input.elimCostCents)}) for ${periodLabelOf(input.periodKey)} — ` +
      `${dir} by ${formatMoney(Math.abs(deltaCents))}. These eliminating accounts must net to zero at the company roll-up; ` +
      `one leg was likely booked to a non-eliminating account, so consolidation will not tie.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion (b) — intercompany due-from == due-to, per period (group-wide)
// ─────────────────────────────────────────────────────────────────────────────

export interface IntercompanyPeriodInput {
  periodKey: string;
  /** Net debit on Intercompany Receivable (role INTERCOMPANY_AR) = due-from. */
  dueFromCents: number;
  /** Net credit on Intercompany Payable (role INTERCOMPANY_AP) = due-to. */
  dueToCents: number;
}

/**
 * Assert intercompany receivable (due-from) nets to intercompany payable (due-to)
 * across the group for a period. Returns null when the pair nets to zero.
 */
export function assessIntercompanyBalance(input: IntercompanyPeriodInput): BalanceSignal | null {
  const deltaCents = input.dueFromCents - input.dueToCents;
  if (Math.abs(deltaCents) < IC_THRESHOLDS.toleranceCents) return null;
  const dir = deltaCents > 0 ? 'due-from exceeds due-to' : 'due-to exceeds due-from';
  return {
    deltaCents,
    confidence: IC_THRESHOLDS.intercompanyConfidence,
    reason:
      `Intercompany positions do not net for ${periodLabelOf(input.periodKey)}: due-from / receivable (${formatMoney(input.dueFromCents)}) ` +
      `≠ due-to / payable (${formatMoney(input.dueToCents)}) — ${dir} by ${formatMoney(Math.abs(deltaCents))}. ` +
      `A reciprocal intercompany entry is missing or mis-booked on one entity; this residual will not eliminate on consolidation.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion (c) — internal invoice booked on one side but not the other
// ─────────────────────────────────────────────────────────────────────────────

export interface InvoiceRef {
  id: string;
  invoiceNumber: string;
  totalCents: number;
}

export interface InvoiceCoverageInput {
  locationId: string;
  companyName: string;
  periodKey: string;
  /** Sum of 'booked' revenue-method internal-invoice totals for the company/period. */
  bookedInvoiceRevenueCents: number;
  /** Interdept revenue actually posted to the GL (assertion (a)'s revenue side). */
  postedInterdeptRevenueCents: number;
  /** 'booked' invoices with booked_gl_entry_id null — booked with no GL entry at all. */
  unbookedInvoices: InvoiceRef[];
}

/**
 * Reconcile the internal-invoice subledger to the GL for a company/period. Fires
 * when a 'booked' invoice has no GL entry (definitively one-sided) OR when the
 * booked revenue-method subledger total does not tie to the interdept revenue on
 * the GL (an invoice posted a cost leg without its revenue leg, or vice versa).
 * Returns null when the subledger ties to the ledger.
 */
export function assessInternalInvoiceCoverage(input: InvoiceCoverageInput): BalanceSignal | null {
  const coverageDelta = input.bookedInvoiceRevenueCents - input.postedInterdeptRevenueCents;
  const hasUnbooked = input.unbookedInvoices.length > 0;
  const hasDrift = Math.abs(coverageDelta) >= IC_THRESHOLDS.toleranceCents;
  if (!hasUnbooked && !hasDrift) return null;

  const unbookedCents = input.unbookedInvoices.reduce((s, i) => s + i.totalCents, 0);
  // $-at-risk = the larger of the un-posted invoice value and the coverage drift.
  const deltaCents = Math.max(unbookedCents, Math.abs(coverageDelta));

  if (hasUnbooked) {
    const list = input.unbookedInvoices
      .map((i) => `${i.invoiceNumber} (${formatMoney(i.totalCents)})`)
      .join(', ');
    return {
      deltaCents,
      confidence: IC_THRESHOLDS.unbookedInvoiceConfidence,
      reason:
        `${input.companyName}: ${input.unbookedInvoices.length} internal invoice(s) marked booked for ${periodLabelOf(input.periodKey)} ` +
        `have no posted GL entry — ${list}. The invoice recorded a charge on one side of the books with nothing posted on the other; ` +
        `${formatMoney(unbookedCents)} of interdepartmental activity is missing from the ledger.`,
    };
  }
  const dir = coverageDelta > 0 ? 'more invoiced than posted' : 'more posted than invoiced';
  return {
    deltaCents,
    confidence: IC_THRESHOLDS.coverageDriftConfidence,
    reason:
      `${input.companyName}: booked internal invoices (${formatMoney(input.bookedInvoiceRevenueCents)}) do not tie to the ` +
      `interdepartmental revenue posted to the GL (${formatMoney(input.postedInterdeptRevenueCents)}) for ${periodLabelOf(input.periodKey)} — ` +
      `${dir} by ${formatMoney(Math.abs(coverageDelta))}. An internal invoice was booked on one side but not the other.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiering — a control exception must always reach a human.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Map an imbalance's confidence + $-at-risk to a surfacing tier. An out-of-balance
 * internal position blocks a clean consolidation, so a proven imbalance in a
 * CLOSED period (SOFT_CLOSE/HARD_CLOSE) is always ESCALATE — it survived into the
 * close and misstates the consolidated statements (FPB EC-3: "ESCALATE for
 * consolidation; REVIEW for timing differences"). In an OPEN period it may still
 * be an in-flight timing difference, so it floors to REVIEW (never `auto` — a
 * control exception is never silently suppressed).
 */
export function resolveBalanceTier(
  confidence: number,
  amountAtRiskCents: number,
  policy: TierPolicy,
  blocksConsolidation: boolean,
): Tier {
  if (blocksConsolidation) return 'escalate';
  const { tier } = scoreToTier({ confidence, amountCents: amountAtRiskCents }, policy);
  return tier === 'auto' ? 'review' : tier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate exception (pre-persistence) + scan orchestration (I/O)
// ─────────────────────────────────────────────────────────────────────────────

export type ICKind = 'interdept_imbalance' | 'intercompany_imbalance' | 'internal_invoice_onesided';

export interface ICCandidate {
  dedupKey: string;
  kind: ICKind;
  confidence: number;
  amountAtRiskCents: number;
  blocksConsolidation: boolean;
  locationId: string | null;
  periodKey: string;
  title: string; // → ai_decisions.input_summary
  reason: string; // → ai_decisions.reasoning
  clarifyingQuestion: string;
  subjects: Record<string, unknown>; // ids for drill-down + remediation
}

export interface IntercompanyScanSummary {
  scanned: { entries: number; eliminatingLines: number; internalInvoices: number };
  detected: number; // candidates found this pass (incl. already-queued)
  queued: number; // NEW exception-queue rows inserted (deduped)
  byKind: Record<ICKind, number>; // NEW rows by kind
  byTier: Record<Tier, number>; // NEW rows by tier
  intercompanyRolesResolved: boolean;
  errors: number;
}

const REMEDIATION_QUESTION: Record<ICKind, string> = {
  interdept_imbalance:
    'Rebook the missing eliminating leg (Interdept Services Revenue ↔ Cost) so the pair nets to zero, or confirm the difference is a genuine third-party cost?',
  intercompany_imbalance:
    'Post the mirror intercompany entry on the counterparty entity so due-from equals due-to, or confirm this is a timing difference clearing next period?',
  internal_invoice_onesided:
    'Post the missing GL entry for the booked internal invoice, or void the invoice if it was recorded in error?',
};

interface LineRow {
  gl_entry_id: string;
  account_id: string;
  debit_cents: number | string;
  credit_cents: number | string;
  location_id: string;
}

function n(v: number | string | null | undefined): number {
  return Number(v) || 0;
}

async function fetchLinesForAccounts(
  supabase: SupabaseClient,
  accountIds: string[],
  entryIds: string[],
): Promise<LineRow[]> {
  const out: LineRow[] = [];
  if (accountIds.length === 0 || entryIds.length === 0) return out;
  for (let i = 0; i < entryIds.length; i += 500) {
    const slice = entryIds.slice(i, i + 500);
    const { data, error } = await supabase
      .from('gl_entry_lines')
      .select('gl_entry_id, account_id, debit_cents, credit_cents, location_id')
      .in('gl_entry_id', slice)
      .in('account_id', accountIds);
    if (error) {
      console.warn('[controls/ic] line load failed:', error.message);
      continue;
    }
    for (const row of (data ?? []) as LineRow[]) out.push(row);
  }
  return out;
}

/**
 * Scan the ledger for EC-3 intercompany / interdepartmental imbalances and queue
 * new exceptions into /exceptions. Never throws — a control scan must not break
 * the maintenance pass it rides on.
 */
export async function scanIntercompanyBalance(
  supabase: SupabaseClient,
  orgId: string,
  opts: { sinceDate?: string } = {},
): Promise<IntercompanyScanSummary> {
  const summary: IntercompanyScanSummary = {
    scanned: { entries: 0, eliminatingLines: 0, internalInvoices: 0 },
    detected: 0,
    queued: 0,
    byKind: { interdept_imbalance: 0, intercompany_imbalance: 0, internal_invoice_onesided: 0 },
    byTier: { auto: 0, review: 0, escalate: 0 },
    intercompanyRolesResolved: false,
    errors: 0,
  };

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(supabase, orgId);
  } catch {
    policy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }

  // ── Company names (core.locations) ──────────────────────────────────────────
  const companyName = new Map<string, string>();
  {
    const { data: locs } = await supabase
      .schema('core')
      .from('locations')
      .select('id, name');
    for (const l of (locs ?? []) as Array<{ id: string; name: string }>) {
      companyName.set(l.id, l.name);
    }
  }

  // ── Fiscal-period status per (location, YYYY-MM) — for close-blocking tier ────
  const periodStatus = new Map<string, string>(); // `${locationId}:${YYYY-MM}` → status
  {
    const { data: periods } = await supabase
      .from('fiscal_periods')
      .select('location_id, period_year, period_month, status')
      .eq('org_id', orgId);
    for (const p of (periods ?? []) as Array<{
      location_id: string;
      period_year: number;
      period_month: number;
      status: string;
    }>) {
      const key = `${p.location_id}:${p.period_year}-${String(p.period_month).padStart(2, '0')}`;
      periodStatus.set(key, p.status);
    }
  }
  const isClosed = (s: string | undefined) => s === 'SOFT_CLOSE' || s === 'HARD_CLOSE';

  // ── Posted GL entries in scope (build id → {date, location}) ─────────────────
  let entryQuery = supabase
    .from('gl_entries')
    .select('id, location_id, entry_date')
    .eq('org_id', orgId)
    .eq('status', 'POSTED');
  if (opts.sinceDate) entryQuery = entryQuery.gte('entry_date', opts.sinceDate);
  const { data: entriesRaw, error: entryErr } = await entryQuery.limit(20000);
  if (entryErr) {
    console.warn('[controls/ic] entries load failed:', entryErr.message);
    return summary;
  }
  const entries = (entriesRaw ?? []) as Array<{ id: string; location_id: string; entry_date: string }>;
  summary.scanned.entries = entries.length;
  const entryMeta = new Map<string, { periodKey: string; locationId: string }>();
  for (const e of entries) {
    entryMeta.set(e.id, { periodKey: periodKeyOf(e.entry_date), locationId: e.location_id });
  }
  const entryIds = entries.map((e) => e.id);

  // ── Eliminating accounts (is_eliminating = true), keyed by type ──────────────
  const elimTypeById = new Map<string, string>();
  {
    const { data: elimAccts } = await supabase
      .from('accounts')
      .select('id, account_type')
      .eq('org_id', orgId)
      .eq('is_eliminating', true);
    for (const a of (elimAccts ?? []) as Array<{ id: string; account_type: string }>) {
      elimTypeById.set(a.id, a.account_type);
    }
  }

  // ── Interdept aggregation (per location + period): eliminating rev vs cost ────
  interface Agg {
    elimRevenueCents: number;
    elimCostCents: number;
  }
  const interdept = new Map<string, Agg>(); // `${locationId}:${periodKey}`
  if (elimTypeById.size > 0 && entryIds.length > 0) {
    const elimLines = await fetchLinesForAccounts(supabase, Array.from(elimTypeById.keys()), entryIds);
    summary.scanned.eliminatingLines = elimLines.length;
    for (const l of elimLines) {
      const meta = entryMeta.get(l.gl_entry_id);
      if (!meta) continue;
      const type = elimTypeById.get(l.account_id);
      const key = `${l.location_id}:${meta.periodKey}`;
      const agg = interdept.get(key) ?? { elimRevenueCents: 0, elimCostCents: 0 };
      if (type === 'REVENUE') {
        // revenue is credit-normal
        agg.elimRevenueCents += n(l.credit_cents) - n(l.debit_cents);
      } else {
        // COGS / OPEX / OTHER cost is debit-normal
        agg.elimCostCents += n(l.debit_cents) - n(l.credit_cents);
      }
      interdept.set(key, agg);
    }
  }

  // ── Intercompany aggregation (per period, group-wide): due-from vs due-to ─────
  const intercompany = new Map<string, { dueFromCents: number; dueToCents: number }>(); // periodKey
  let icAr: string | null = null;
  let icAp: string | null = null;
  try {
    icAr = (await resolveRole(supabase, orgId, 'INTERCOMPANY_AR')).id;
    icAp = (await resolveRole(supabase, orgId, 'INTERCOMPANY_AP')).id;
    summary.intercompanyRolesResolved = true;
  } catch (e) {
    if (!(e instanceof PostingError)) {
      console.warn('[controls/ic] intercompany role resolve failed:', e instanceof Error ? e.message : e);
    }
    // Roles not seeded → skip assertion (b), still run (a) and (c).
  }
  if (icAr && icAp && entryIds.length > 0) {
    const icLines = await fetchLinesForAccounts(supabase, [icAr, icAp], entryIds);
    for (const l of icLines) {
      const meta = entryMeta.get(l.gl_entry_id);
      if (!meta) continue;
      const agg = intercompany.get(meta.periodKey) ?? { dueFromCents: 0, dueToCents: 0 };
      if (l.account_id === icAr) {
        agg.dueFromCents += n(l.debit_cents) - n(l.credit_cents); // receivable, debit-normal
      } else {
        agg.dueToCents += n(l.credit_cents) - n(l.debit_cents); // payable, credit-normal
      }
      intercompany.set(meta.periodKey, agg);
    }
  }

  // ── Internal-invoice subledger (per location + period) ───────────────────────
  interface Cov {
    bookedInvoiceRevenueCents: number;
    unbookedInvoices: InvoiceRef[];
  }
  const coverage = new Map<string, Cov>(); // `${locationId}:${periodKey}`
  {
    let invQuery = supabase
      .from('internal_invoices')
      .select('id, invoice_number, location_id, invoice_date, charge_method, status, total_cents, booked_gl_entry_id')
      .eq('org_id', orgId)
      .eq('status', 'booked');
    if (opts.sinceDate) invQuery = invQuery.gte('invoice_date', opts.sinceDate);
    const { data: invsRaw, error: invErr } = await invQuery.limit(10000);
    if (invErr) {
      console.warn('[controls/ic] internal invoices load failed:', invErr.message);
    }
    const invs = (invsRaw ?? []) as Array<{
      id: string;
      invoice_number: string;
      location_id: string;
      invoice_date: string;
      charge_method: string;
      status: string;
      total_cents: number | string;
      booked_gl_entry_id: string | null;
    }>;
    summary.scanned.internalInvoices = invs.length;
    for (const inv of invs) {
      const pk = periodKeyOf(inv.invoice_date);
      const key = `${inv.location_id}:${pk}`;
      const cov = coverage.get(key) ?? { bookedInvoiceRevenueCents: 0, unbookedInvoices: [] };
      // Only revenue-method invoices post interdept REVENUE; cost-transfer posts none.
      if (inv.charge_method === 'revenue') {
        cov.bookedInvoiceRevenueCents += n(inv.total_cents);
      }
      if (!inv.booked_gl_entry_id) {
        cov.unbookedInvoices.push({
          id: inv.id,
          invoiceNumber: inv.invoice_number,
          totalCents: n(inv.total_cents),
        });
      }
      coverage.set(key, cov);
    }
  }

  // ── Build candidates ─────────────────────────────────────────────────────────
  const candidates: ICCandidate[] = [];

  // (a) interdept imbalance
  for (const [key, agg] of interdept) {
    const [locationId, periodKey] = key.split(':');
    const name = companyName.get(locationId) ?? 'Unknown company';
    const sig = assessInterdeptBalance({
      locationId,
      companyName: name,
      periodKey,
      elimRevenueCents: agg.elimRevenueCents,
      elimCostCents: agg.elimCostCents,
    });
    if (!sig) continue;
    const blocks = isClosed(periodStatus.get(`${locationId}:${periodKey}`));
    candidates.push({
      dedupKey: `ic_bal:interdept:${locationId}:${periodKey}`,
      kind: 'interdept_imbalance',
      confidence: sig.confidence,
      amountAtRiskCents: Math.abs(sig.deltaCents),
      blocksConsolidation: blocks,
      locationId,
      periodKey,
      title: `Interdept out-of-balance: ${name} · ${periodLabelOf(periodKey)} · ${formatMoney(Math.abs(sig.deltaCents))}`,
      reason: sig.reason,
      clarifyingQuestion: REMEDIATION_QUESTION.interdept_imbalance,
      subjects: {
        location_id: locationId,
        period_key: periodKey,
        elim_revenue_cents: agg.elimRevenueCents,
        elim_cost_cents: agg.elimCostCents,
        delta_cents: sig.deltaCents,
      },
    });
  }

  // (b) intercompany imbalance
  for (const [periodKey, agg] of intercompany) {
    const sig = assessIntercompanyBalance({
      periodKey,
      dueFromCents: agg.dueFromCents,
      dueToCents: agg.dueToCents,
    });
    if (!sig) continue;
    // Group-wide: blocks consolidation if ANY entity's period for this month is closed.
    let blocks = false;
    for (const [k, s] of periodStatus) {
      if (k.endsWith(`:${periodKey}`) && isClosed(s)) {
        blocks = true;
        break;
      }
    }
    candidates.push({
      dedupKey: `ic_bal:intercompany:${periodKey}`,
      kind: 'intercompany_imbalance',
      confidence: sig.confidence,
      amountAtRiskCents: Math.abs(sig.deltaCents),
      blocksConsolidation: blocks,
      locationId: null,
      periodKey,
      title: `Intercompany due-to ≠ due-from: ${periodLabelOf(periodKey)} · ${formatMoney(Math.abs(sig.deltaCents))}`,
      reason: sig.reason,
      clarifyingQuestion: REMEDIATION_QUESTION.intercompany_imbalance,
      subjects: {
        period_key: periodKey,
        due_from_cents: agg.dueFromCents,
        due_to_cents: agg.dueToCents,
        delta_cents: sig.deltaCents,
      },
    });
  }

  // (c) one-sided internal invoice / subledger-to-GL coverage
  for (const [key, cov] of coverage) {
    const [locationId, periodKey] = key.split(':');
    const name = companyName.get(locationId) ?? 'Unknown company';
    const postedInterdeptRevenueCents = interdept.get(key)?.elimRevenueCents ?? 0;
    const sig = assessInternalInvoiceCoverage({
      locationId,
      companyName: name,
      periodKey,
      bookedInvoiceRevenueCents: cov.bookedInvoiceRevenueCents,
      postedInterdeptRevenueCents,
      unbookedInvoices: cov.unbookedInvoices,
    });
    if (!sig) continue;
    const blocks = isClosed(periodStatus.get(`${locationId}:${periodKey}`));
    candidates.push({
      dedupKey: `ic_bal:onesided:${locationId}:${periodKey}`,
      kind: 'internal_invoice_onesided',
      confidence: sig.confidence,
      amountAtRiskCents: Math.abs(sig.deltaCents),
      blocksConsolidation: blocks,
      locationId,
      periodKey,
      title: `Internal invoice booked one-sided: ${name} · ${periodLabelOf(periodKey)} · ${formatMoney(Math.abs(sig.deltaCents))}`,
      reason: sig.reason,
      clarifyingQuestion: REMEDIATION_QUESTION.internal_invoice_onesided,
      subjects: {
        location_id: locationId,
        period_key: periodKey,
        booked_invoice_revenue_cents: cov.bookedInvoiceRevenueCents,
        posted_interdept_revenue_cents: postedInterdeptRevenueCents,
        unbooked_invoice_ids: cov.unbookedInvoices.map((i) => i.id),
      },
    });
  }

  summary.detected = candidates.length;
  if (candidates.length === 0) return summary;

  // ── Idempotency: skip any dedup_key already open OR already resolved ─────────
  const existingKeys = new Set<string>();
  try {
    const { data: open } = await supabase
      .from('ai_decisions')
      .select('proposed_output')
      .eq('feature', IC_FEATURE)
      .in('status', ['PROPOSED', 'APPROVED', 'REJECTED']);
    for (const row of open ?? []) {
      const po = (row as { proposed_output?: { dedup_key?: string } }).proposed_output;
      if (po?.dedup_key) existingKeys.add(po.dedup_key);
    }
  } catch {
    /* best-effort — worst case we rely on nothing and may re-queue */
  }

  // ── Insert new exceptions + write the AI audit trail ─────────────────────────
  for (const c of candidates) {
    if (existingKeys.has(c.dedupKey)) continue;
    const tier = resolveBalanceTier(c.confidence, c.amountAtRiskCents, policy, c.blocksConsolidation);
    const confidence = toConfidence(c.confidence);

    const { error } = await supabase.from('ai_decisions').insert({
      org_id: orgId,
      location_id: c.locationId,
      feature: IC_FEATURE,
      input_summary: c.title,
      proposed_output: {
        control: 'EC-3',
        kind: c.kind,
        dedup_key: c.dedupKey,
        amount_at_risk_cents: c.amountAtRiskCents,
        tier,
        period_key: c.periodKey,
        blocks_consolidation: c.blocksConsolidation,
        subjects: c.subjects,
        reason: c.reason,
      },
      confidence,
      reasoning: c.reason,
      clarifying_question: c.clarifyingQuestion,
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      console.warn('[controls/ic] could not queue exception:', error.message);
      summary.errors += 1;
      continue;
    }
    existingKeys.add(c.dedupKey);
    summary.queued += 1;
    summary.byKind[c.kind] += 1;
    summary.byTier[tier] += 1;

    // Trust audit trail — the AI's detection, actor = AI (canon §3 / FPB D7).
    await logAction(supabase, {
      orgId,
      actorType: 'AI',
      actorUserId: null,
      action: 'controls.intercompany_balance.detect',
      subjectTable: c.kind === 'internal_invoice_onesided' ? 'internal_invoices' : 'gl_entry_lines',
      subjectId: null,
      summary: c.title,
      locationId: c.locationId,
      confidence,
      tier,
      metadata: {
        kind: c.kind,
        dedup_key: c.dedupKey,
        period_key: c.periodKey,
        amount_at_risk_cents: c.amountAtRiskCents,
        blocks_consolidation: c.blocksConsolidation,
      },
    });
  }

  return summary;
}
