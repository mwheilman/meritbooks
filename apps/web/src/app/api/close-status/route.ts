export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { scanUncategorizedLeakage, type LeakageKind } from '@/lib/controls/uncategorized-leakage';
import type { Tier } from '@/lib/trust/score-tier';

/**
 * Close Command Center — real-time, per-entity close-readiness board.
 *
 * READ-ONLY intelligence for the accounting-manager / practice-supervisor persona
 * (discovery: accounting-manager.md B1 "real-time close command center" +
 * accounting-firm-partner.md B1/B2 "portfolio close tracking"). For the selected
 * fiscal period it answers, per entity (core.locations), the one question the
 * manager cannot get without pinging people: "where is every entity in the close,
 * and what is blocking a clean one?"
 *
 * The board is DERIVED from live ledger/queue state, never a typed-in checklist
 * (canon: "Complete is demonstrated, not asserted"). Per entity it composes:
 *   - period status .......... fiscal_periods.status (OPEN / SOFT_CLOSE / HARD_CLOSE)
 *   - bank reconciliation .... bank_reconciliations.is_reconciled for the period
 *                              (complete / incomplete / not started)
 *   - uncategorized/unposted . EC-4 close-readiness ($ real economic activity not
 *                              yet in the GL) — reuses computeCloseReadiness via a
 *                              DRY-RUN scanUncategorizedLeakage (no writes)
 *   - open exceptions ........ ai_decisions status='PROPOSED' (the review queue),
 *                              with $ at risk when the proposal carries it
 *   - flagged operational .... bank FLAGGED + receipt FLAGGED + bill ON_HOLD
 * and rolls them into a green/amber/red readiness verdict with an explicit
 * "what's blocking" list, plus a portfolio roll-up (how many entities are
 * close-ready vs at-risk vs blocked vs already closed).
 *
 * Distinct from /api/close (the manual close CHECKLIST). This route asserts NO
 * status of its own; it reflects the books.
 *
 * Security: every query runs through the RLS-scoped authed client, so the database
 * enforces tenant isolation — this route never filters org_id by hand. All money is
 * bigint cents.
 */

// ── Public API shape ─────────────────────────────────────────────────────────

export type Readiness = 'ready' | 'at_risk' | 'blocked' | 'closed' | 'no_period';
export type BankRecState = 'complete' | 'incomplete' | 'none';
export type PeriodStatus = 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' | 'NO_PERIOD';

export interface CloseStatusBlocker {
  severity: 'hard' | 'soft';
  label: string;
}

export interface EntityCloseStatus {
  locationId: string;
  name: string;
  shortCode: string;
  periodStatus: PeriodStatus;
  closedAt: string | null;
  /** bank reconciliation for the selected period. */
  bankRec: BankRecState;
  bankRecTotal: number;
  bankRecReconciled: number;
  /** EC-4: real economic activity not yet in the GL (aged, current state). */
  leakageAtRiskCents: number;
  leakageItems: number;
  leakageTier: Tier | null;
  leakageByKind: Record<LeakageKind, number>;
  /** ai_decisions PROPOSED — the review queue for this entity. */
  openExceptions: number;
  exceptionAtRiskCents: number;
  /** operational review flags: bank FLAGGED + receipt FLAGGED + bill ON_HOLD. */
  flaggedItems: number;
  readiness: Readiness;
  blockers: CloseStatusBlocker[];
}

export interface CloseStatusSummary {
  totalEntities: number;
  ready: number;
  atRisk: number;
  blocked: number;
  closed: number;
  noPeriod: number;
  /** entities with everything in place to sign a clean close (ready + closed). */
  closeReady: number;
  totalLeakageAtRiskCents: number;
  blockingLeakageAtRiskCents: number;
  totalOpenExceptions: number;
  totalFlagged: number;
  entitiesReconciled: number;
}

export interface CloseStatusResponse {
  period: { year: number; month: number; key: string; label: string };
  generatedAt: string;
  summary: CloseStatusSummary;
  entities: EntityCloseStatus[];
}

// ── Internal row shapes (only the columns we select) ─────────────────────────

interface LocationRow {
  id: string;
  name: string;
  short_code: string;
}
interface PeriodRow {
  id: string;
  location_id: string;
  status: PeriodStatus;
  closed_at: string | null;
}
interface ReconRow {
  fiscal_period_id: string;
  is_reconciled: boolean | null;
}
interface AiRow {
  location_id: string | null;
  proposed_output: { amount_at_risk_cents?: number | string } | null;
}
interface LocatedRow {
  location_id: string | null;
}

const ROW_CAP = 5000;

function emptyByKind(): Record<LeakageKind, number> {
  return { uncoded_bank: 0, unposted_receipt: 0, unpaid_bill: 0 };
}

function tally(rows: LocatedRow[] | null): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows ?? []) {
    if (!r.location_id) continue;
    m.set(r.location_id, (m.get(r.location_id) ?? 0) + 1);
  }
  return m;
}

function toCents(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const now = new Date();
  const { searchParams } = new URL(request.url);
  const year = parseInt(searchParams.get('year') ?? String(now.getFullYear()), 10);
  const month = parseInt(searchParams.get('month') ?? String(now.getMonth() + 1), 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: 'Invalid period', code: 'BAD_REQUEST' }, { status: 400 });
  }
  const periodKey = `${year}-${String(month).padStart(2, '0')}`;
  const periodLabel = new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

  // Active entities (locations live in `core`; the ledger tables in `public`).
  const { data: locData, error: locErr } = await supabase
    .schema('core')
    .from('locations')
    .select('id, name, short_code')
    .eq('is_active', true)
    .order('name');
  if (locErr) return NextResponse.json({ error: locErr.message, code: 'INTERNAL_ERROR' }, { status: 500 });
  const locations = (locData ?? []) as LocationRow[];

  // Fiscal periods for the selected month → per-entity period status.
  const { data: periodData, error: periodErr } = await supabase
    .from('fiscal_periods')
    .select('id, location_id, status, closed_at')
    .eq('period_year', year)
    .eq('period_month', month);
  if (periodErr) return NextResponse.json({ error: periodErr.message, code: 'INTERNAL_ERROR' }, { status: 500 });
  const periods = (periodData ?? []) as PeriodRow[];

  const periodByLoc = new Map<string, PeriodRow>();
  const locByPeriodId = new Map<string, string>();
  for (const p of periods) {
    periodByLoc.set(p.location_id, p);
    locByPeriodId.set(p.id, p.location_id);
  }
  const periodIds = periods.map((p) => p.id);

  // Fire the independent reads together. EC-4 dry-run rides its own promise —
  // it never throws (control scans must not break the pass they ride on).
  const [reconRes, aiRes, bankFlagRes, receiptFlagRes, billHoldRes, leakage] = await Promise.all([
    periodIds.length > 0
      ? supabase
          .from('bank_reconciliations')
          .select('fiscal_period_id, is_reconciled')
          .in('fiscal_period_id', periodIds)
          .limit(ROW_CAP)
      : Promise.resolve({ data: [] as ReconRow[], error: null }),
    supabase
      .from('ai_decisions')
      .select('location_id, proposed_output')
      .eq('status', 'PROPOSED')
      .limit(ROW_CAP),
    supabase.from('bank_transactions').select('location_id').eq('status', 'FLAGGED').limit(ROW_CAP),
    supabase.from('receipts').select('location_id').eq('status', 'FLAGGED').limit(ROW_CAP),
    supabase.from('bills').select('location_id').eq('status', 'ON_HOLD').limit(ROW_CAP),
    scanUncategorizedLeakage(supabase, orgId, { dryRun: true, asOfISO: now.toISOString() }),
  ]);

  const firstError = reconRes.error || aiRes.error || bankFlagRes.error || receiptFlagRes.error || billHoldRes.error;
  if (firstError) {
    console.error('[close-status] query failed:', firstError.message);
    return NextResponse.json({ error: 'Failed to load close status', code: 'INTERNAL_ERROR' }, { status: 500 });
  }

  // Bank reconciliation totals per entity (via fiscal_period_id → location).
  const recTotal = new Map<string, number>();
  const recDone = new Map<string, number>();
  for (const r of (reconRes.data ?? []) as ReconRow[]) {
    const loc = locByPeriodId.get(r.fiscal_period_id);
    if (!loc) continue;
    recTotal.set(loc, (recTotal.get(loc) ?? 0) + 1);
    if (r.is_reconciled) recDone.set(loc, (recDone.get(loc) ?? 0) + 1);
  }

  // Open exceptions (ai_decisions PROPOSED) per entity, with $ where carried.
  const excCount = new Map<string, number>();
  const excAtRisk = new Map<string, number>();
  for (const a of (aiRes.data ?? []) as AiRow[]) {
    if (!a.location_id) continue;
    excCount.set(a.location_id, (excCount.get(a.location_id) ?? 0) + 1);
    const cents = toCents(a.proposed_output?.amount_at_risk_cents);
    if (cents) excAtRisk.set(a.location_id, (excAtRisk.get(a.location_id) ?? 0) + cents);
  }

  // Operational flags per entity (mirrors /api/client-health).
  const bankFlag = tally(bankFlagRes.data as LocatedRow[] | null);
  const receiptFlag = tally(receiptFlagRes.data as LocatedRow[] | null);
  const billHold = tally(billHoldRes.data as LocatedRow[] | null);

  // EC-4 leakage rolled up per entity across all aged periods (current state) —
  // aged money-not-in-the-GL blocks a clean close regardless of which month it
  // landed in, which is exactly how a controller reasons about it.
  const leakAtRisk = new Map<string, number>();
  const leakItems = new Map<string, number>();
  const leakByKind = new Map<string, Record<LeakageKind, number>>();
  const leakTier = new Map<string, Tier>();
  const tierRank: Record<Tier, number> = { auto: 0, review: 1, escalate: 2 };
  for (const row of leakage.closeReadiness.byCompanyPeriod) {
    if (!row.locationId) continue;
    const loc = row.locationId;
    leakAtRisk.set(loc, (leakAtRisk.get(loc) ?? 0) + row.atRiskCents);
    leakItems.set(loc, (leakItems.get(loc) ?? 0) + row.items);
    const byKind = leakByKind.get(loc) ?? emptyByKind();
    byKind.uncoded_bank += row.byKind.uncoded_bank;
    byKind.unposted_receipt += row.byKind.unposted_receipt;
    byKind.unpaid_bill += row.byKind.unpaid_bill;
    leakByKind.set(loc, byKind);
    const prior = leakTier.get(loc);
    if (!prior || tierRank[row.tier] > tierRank[prior]) leakTier.set(loc, row.tier);
  }

  // ── Compose per-entity readiness ──────────────────────────────────────────
  const entities: EntityCloseStatus[] = locations.map((loc) => {
    const period = periodByLoc.get(loc.id);
    const periodStatus: PeriodStatus = period?.status ?? 'NO_PERIOD';

    const total = recTotal.get(loc.id) ?? 0;
    const done = recDone.get(loc.id) ?? 0;
    const bankRec: BankRecState = total === 0 ? 'none' : done >= total ? 'complete' : 'incomplete';

    const leakageAtRiskCents = leakAtRisk.get(loc.id) ?? 0;
    const leakageItems = leakItems.get(loc.id) ?? 0;
    const leakageTier = leakTier.get(loc.id) ?? null;
    const leakageByKind = leakByKind.get(loc.id) ?? emptyByKind();
    const openExceptions = excCount.get(loc.id) ?? 0;
    const exceptionAtRiskCents = excAtRisk.get(loc.id) ?? 0;
    const flaggedItems = (bankFlag.get(loc.id) ?? 0) + (receiptFlag.get(loc.id) ?? 0) + (billHold.get(loc.id) ?? 0);

    // Assemble "what's blocking". Hard blockers force red; soft ones force amber.
    const blockers: CloseStatusBlocker[] = [];

    if (leakageTier === 'escalate') {
      blockers.push({
        severity: 'hard',
        label: `${fmt(leakageAtRiskCents)} uncategorized/unposted — must clear (blocks close)`,
      });
    } else if (leakageAtRiskCents > 0) {
      blockers.push({
        severity: 'soft',
        label: `${fmt(leakageAtRiskCents)} in ${leakageItems} item(s) not yet in the GL`,
      });
    }

    if (bankRec === 'incomplete') {
      blockers.push({ severity: 'hard', label: `Bank reconciliation incomplete (${done}/${total} accounts)` });
    } else if (bankRec === 'none' && periodStatus !== 'HARD_CLOSE') {
      blockers.push({ severity: 'soft', label: 'Bank reconciliation not started' });
    }

    if (openExceptions > 0) {
      const suffix = exceptionAtRiskCents > 0 ? ` (${fmt(exceptionAtRiskCents)} at risk)` : '';
      blockers.push({ severity: 'soft', label: `${openExceptions} open exception(s) in review queue${suffix}` });
    }
    if (flaggedItems > 0) {
      blockers.push({ severity: 'soft', label: `${flaggedItems} flagged item(s) awaiting review` });
    }

    let readiness: Readiness;
    if (periodStatus === 'NO_PERIOD') {
      readiness = 'no_period';
    } else if (periodStatus === 'HARD_CLOSE') {
      readiness = 'closed';
    } else if (blockers.some((b) => b.severity === 'hard')) {
      readiness = 'blocked';
    } else if (blockers.length > 0) {
      readiness = 'at_risk';
    } else {
      readiness = 'ready';
    }

    return {
      locationId: loc.id,
      name: loc.name,
      shortCode: loc.short_code,
      periodStatus,
      closedAt: period?.closed_at ?? null,
      bankRec,
      bankRecTotal: total,
      bankRecReconciled: done,
      leakageAtRiskCents,
      leakageItems,
      leakageTier,
      leakageByKind,
      openExceptions,
      exceptionAtRiskCents,
      flaggedItems,
      readiness,
      blockers,
    };
  });

  // Worst-first: blocked → at_risk → ready → closed → no_period, then by $ at risk.
  const rank: Record<Readiness, number> = { blocked: 4, at_risk: 3, ready: 2, closed: 1, no_period: 0 };
  const pressure = (e: EntityCloseStatus) =>
    e.leakageAtRiskCents + e.exceptionAtRiskCents + e.flaggedItems * 100 + (e.bankRec === 'incomplete' ? 1e9 : 0);
  entities.sort((a, b) => rank[b.readiness] - rank[a.readiness] || pressure(b) - pressure(a));

  const summary: CloseStatusSummary = {
    totalEntities: entities.length,
    ready: entities.filter((e) => e.readiness === 'ready').length,
    atRisk: entities.filter((e) => e.readiness === 'at_risk').length,
    blocked: entities.filter((e) => e.readiness === 'blocked').length,
    closed: entities.filter((e) => e.readiness === 'closed').length,
    noPeriod: entities.filter((e) => e.readiness === 'no_period').length,
    closeReady: entities.filter((e) => e.readiness === 'ready' || e.readiness === 'closed').length,
    totalLeakageAtRiskCents: entities.reduce((n, e) => n + e.leakageAtRiskCents, 0),
    blockingLeakageAtRiskCents: entities.reduce(
      (n, e) => n + (e.leakageTier === 'escalate' ? e.leakageAtRiskCents : 0),
      0
    ),
    totalOpenExceptions: entities.reduce((n, e) => n + e.openExceptions, 0),
    totalFlagged: entities.reduce((n, e) => n + e.flaggedItems, 0),
    entitiesReconciled: entities.filter((e) => e.bankRec === 'complete').length,
  };

  const response: CloseStatusResponse = {
    period: { year, month, key: periodKey, label: periodLabel },
    generatedAt: now.toISOString(),
    summary,
    entities,
  };
  return NextResponse.json(response);
}

// Local money formatter (server) — mirrors formatMoney's plain form without a
// client import in a route handler.
function fmt(cents: number): string {
  const v = Math.abs(cents) / 100;
  const s = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
  return cents < 0 ? `(${s})` : s;
}
