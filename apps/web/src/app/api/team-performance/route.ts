export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveActor } from '@/lib/trust/actor';
import type { ActorType, Tier } from '@/lib/trust/action-log';
import { buildSalesTaxCalendar } from '@/lib/tax/sales-tax-calendar';
import {
  resolveWorkActions,
  resolveTargets,
  computeThroughput,
  computeDollars,
  buildLeaderboard,
  latencyMs,
  averageLatencyMs,
  medianLatencyMs,
  msToHours,
  safeRate,
  closeDueDateForPeriod,
  isCloseOnTime,
  calendarDaysBetween,
  rollupCloseAdherence,
  isFilingOnTime,
  rollupFilingAdherence,
  type Targets,
  type ScorecardInput,
  type LeaderboardEntry,
  type WorkActionDef,
  type DollarItem,
  type DollarFamily,
  type ClosePeriodEval,
  type FilingEval,
} from '@/lib/team-performance/compute';

/**
 * GET /api/team-performance — the accounting-manager performance scorecard.
 *
 * Answers, per team member and rolled up to the team, the exact questions the
 * owner asked: who is processing WHAT VOLUME (item count), moving HOW MANY DOLLARS,
 * how fast (cycle time), how cleanly (rework/override), AND — team-level — is the
 * shop closing the books ON SCHEDULE and filing regulatory returns ON TIME.
 *
 * Everything is DETERMINISTIC and derived from EXISTING tables (no schema change):
 *   • Volume by count + $ ....... core.action_log (attribution spine) joined to
 *                                 gl_entry_lines / bills / invoices / payroll+check
 *                                 action metadata (all bigint cents).
 *   • Cycle time ................ bank_transactions timestamps (074).
 *   • Quality (rework/override) . gl_entries reversals + bank_transactions ai vs final.
 *   • Close-schedule adherence .. fiscal_periods (status/closed_at) vs the target
 *                                 close business-day (DEFAULT_TARGETS.closeBusinessDay).
 *   • Filing-schedule adherence . sales-tax filing calendar + compliance_filings.
 *
 * ── Scope / RBAC (privacy boundary) ──
 *   ?scope=self  → auth only; ONLY the caller's own card (no peers, no leaderboard,
 *                  no org close/filing KPIs). A bookkeeper's coaching self-view.
 *   ?scope=team  → requires permission('team','view'); every card + team roll-up +
 *                  quality-gated leaderboard + close/filing adherence. (default)
 *
 * ── Windows ── ?days=N (default 30, clamped 1..366) governs the ACTIVITY window
 * (throughput / dollars / cycle time). Close & filing adherence use a fixed trailing
 * 12-month lookback so a short activity window never blanks the compliance history.
 *
 * ── Attribution (CANON §2) ── who-did-what is action_log.actor_user_id, NEVER
 * gl_entries.created_by (null for AI + on the bank-feed/JE paths).
 *
 * ── null-when-no-data ── a metric with no supporting rows returns null / "n/a",
 * never a flattering 0.
 */

const MAX_ROWS = 5000;
const DAY_MS = 86_400_000;
const CLOSE_LOOKBACK_MONTHS = 12;
const FILING_LOOKAHEAD_MONTHS = 3;
const TIERS: Tier[] = ['auto', 'review', 'escalate'];

const NEEDS_CENTRAL = [
  'A dedicated `team_performance` permission (view_all vs view_self) would be cleaner than reusing `team:view` for the manager gate — reserved-spine permissions.ts change, reported not made.',
  'Dollars-processed and cycle-time are only as complete as action_log instrumentation + the 074 timestamps: metrics accrue going forward as more routes stamp `categorized_at` and log a resolved actor_user_id (FPB Dim 16).',
  'Close-owner attribution uses the most-recent `period.status` actor from the log (fiscal_periods.closed_by is written as a Clerk id into a uuid column and is not reliably joinable); a first-class close-owner FK would harden it.',
];

interface LogRow {
  actor_type: ActorType;
  actor_user_id: string | null;
  action: string;
  subject_id: string | null;
  tier: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

interface TxnRow {
  id: string;
  ai_account_id: string | null;
  final_account_id: string | null;
  created_at: string | null;
  categorized_at: string | null;
  approved_at: string | null;
}

interface PersonAccum {
  actions: string[]; // finished-work action strings (for T7 throughput)
  allActionDates: string[]; // every logged action (engagement)
  lastActive: string | null;
  humanActions: number;
  // Q4 override (bank feed)
  approvedTxns: number;
  overrides: number;
  // cycle time — arrays of latencies in ms, null where untimed
  uploadToCategorized: Array<number | null>;
  categorizedToApproved: Array<number | null>;
  approvalLatency: Array<number | null>;
  // Q1 rework — gl.post subject ids this person authored
  postSubjectIds: Set<string>;
  posts: number;
  // Dollars processed (owner KPI #2)
  billApproveIds: string[]; // subject_id = bills.id
  invoiceSendIds: string[]; // subject_id = invoices.id
  payrollCents: number; // from payroll.run.approve metadata.grossCents
  paymentsCents: number; // from checks.approve metadata.amountCents
}

function newAccum(): PersonAccum {
  return {
    actions: [],
    allActionDates: [],
    lastActive: null,
    humanActions: 0,
    approvedTxns: 0,
    overrides: 0,
    uploadToCategorized: [],
    categorizedToApproved: [],
    approvalLatency: [],
    postSubjectIds: new Set(),
    posts: 0,
    billApproveIds: [],
    invoiceSendIds: [],
    payrollCents: 0,
    paymentsCents: 0,
  };
}

function asTier(v: string | null): Tier | null {
  return v && (TIERS as string[]).includes(v) ? (v as Tier) : null;
}

function metaCents(meta: Record<string, unknown> | null, key: string): number {
  if (!meta) return 0;
  const v = Number(meta[key]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const scope = url.searchParams.get('scope') === 'self' ? 'self' : 'team';
  const daysRaw = Number(url.searchParams.get('days') ?? '30');
  const days = Number.isFinite(daysRaw) ? Math.min(366, Math.max(1, Math.floor(daysRaw))) : 30;

  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // ── RBAC gate ──────────────────────────────────────────────────────────────
  let selfUserId: string | null = null;
  if (scope === 'team') {
    const guard = await requirePermission(userId, 'team', 'view');
    if (!guard.ok) return guard.response;
  } else {
    const { coreUserId } = await resolveActor(supabase, userId);
    selfUserId = coreUserId;
    if (!selfUserId) {
      return NextResponse.json({
        scope,
        period: { days, since: new Date(Date.now() - days * DAY_MS).toISOString(), label: `Last ${days} days` },
        kpis: null,
        people: [],
        leaderboard: null,
        close: null,
        filing: null,
        needsCentral: NEEDS_CENTRAL,
      });
    }
  }

  const sinceIso = new Date(Date.now() - days * DAY_MS).toISOString();

  // ── Tenant performance config (weights + targets); RLS-scoped. ───────────────
  const { data: cfg } = await supabase
    .from('performance_config')
    .select('action_weights, targets')
    .eq('org_id', orgId)
    .maybeSingle();
  const catalog = resolveWorkActions((cfg?.action_weights ?? null) as Record<string, number> | null);
  const targets: Targets = resolveTargets((cfg?.targets ?? null) as Partial<Targets> | null);

  // ── action_log activity window (the attribution spine), RLS-scoped. ──────────
  const { data: logRows, error: logErr } = await supabase
    .schema('core')
    .from('action_log')
    .select('actor_type, actor_user_id, action, subject_id, tier, created_at, metadata')
    .eq('org_id', orgId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);
  if (logErr) return NextResponse.json({ error: logErr.message, code: 'QUERY_ERROR' }, { status: 500 });

  const rows = (logRows ?? []) as LogRow[];

  const actorSplit: Record<ActorType, number> = { HUMAN: 0, AI: 0, SYSTEM: 0 };
  const aiTiers: Record<Tier, number> = { auto: 0, review: 0, escalate: 0 };

  const people = new Map<string, PersonAccum>();
  const bankApproveSubjectIds = new Set<string>();
  const allBillApproveIds = new Set<string>();
  const allInvoiceSendIds = new Set<string>();
  const glPostSubjects: Array<{ userId: string; subjectId: string }> = [];

  for (const r of rows) {
    if (r.actor_type === 'HUMAN' || r.actor_type === 'AI' || r.actor_type === 'SYSTEM') {
      actorSplit[r.actor_type] += 1;
    }
    if (r.actor_type === 'AI') {
      const t = asTier(r.tier);
      if (t) aiTiers[t] += 1;
    }
    if (r.actor_type !== 'HUMAN' || !r.actor_user_id) continue;
    if (scope === 'self' && r.actor_user_id !== selfUserId) continue;

    const acc = people.get(r.actor_user_id) ?? newAccum();
    acc.humanActions += 1;
    acc.allActionDates.push(r.created_at);
    if (!acc.lastActive || r.created_at > acc.lastActive) acc.lastActive = r.created_at;

    const def: WorkActionDef | undefined = catalog[r.action];
    if (def) acc.actions.push(r.action);

    if (r.action === 'bankfeed.approve' && r.subject_id) {
      bankApproveSubjectIds.add(r.subject_id);
    }
    if (r.action === 'gl.post' && r.subject_id) {
      acc.posts += 1;
      acc.postSubjectIds.add(r.subject_id);
      glPostSubjects.push({ userId: r.actor_user_id, subjectId: r.subject_id });
    }
    // Dollars (owner KPI #2): capture the value each person moved.
    if (r.action === 'bill.approve' && r.subject_id) {
      acc.billApproveIds.push(r.subject_id);
      allBillApproveIds.add(r.subject_id);
    }
    if (r.action === 'invoice.send' && r.subject_id) {
      acc.invoiceSendIds.push(r.subject_id);
      allInvoiceSendIds.add(r.subject_id);
    }
    if (r.action === 'payroll.run.approve') acc.payrollCents += metaCents(r.metadata, 'grossCents');
    if (r.action === 'checks.approve') acc.paymentsCents += metaCents(r.metadata, 'amountCents');

    people.set(r.actor_user_id, acc);
  }

  const aiTierTotal = aiTiers.auto + aiTiers.review + aiTiers.escalate;
  const autonomyRate = aiTierTotal > 0 ? aiTiers.auto / aiTierTotal : null;

  // ── Bank-feed approvals → bank_transactions (Q4 override + cycle time). ───────
  const txnById = new Map<string, TxnRow>();
  if (bankApproveSubjectIds.size > 0) {
    const ids = Array.from(bankApproveSubjectIds).slice(0, MAX_ROWS);
    const { data: txns } = await supabase
      .from('bank_transactions')
      .select('id, ai_account_id, final_account_id, created_at, categorized_at, approved_at')
      .in('id', ids)
      .limit(MAX_ROWS);
    for (const t of (txns ?? []) as TxnRow[]) txnById.set(t.id, t);
  }

  for (const r of rows) {
    if (r.actor_type !== 'HUMAN' || r.action !== 'bankfeed.approve' || !r.actor_user_id || !r.subject_id) continue;
    if (scope === 'self' && r.actor_user_id !== selfUserId) continue;
    const acc = people.get(r.actor_user_id);
    const txn = txnById.get(r.subject_id);
    if (!acc || !txn) continue;
    acc.approvedTxns += 1;
    if (txn.ai_account_id && txn.final_account_id && txn.ai_account_id !== txn.final_account_id) {
      acc.overrides += 1;
    }
    acc.uploadToCategorized.push(latencyMs(txn.created_at, txn.categorized_at));
    acc.categorizedToApproved.push(latencyMs(txn.categorized_at, txn.approved_at));
    acc.approvalLatency.push(latencyMs(txn.created_at, txn.approved_at));
  }

  // ── Dollar amounts: resolve subject ids → record amounts (bigint cents). ──────
  // journal $: sum of DEBITS on the posted entry (debits == credits, so debit total
  // is the entry's gross value).
  const glDebitByEntry = new Map<string, number>();
  const allPostIds = glPostSubjects.map((p) => p.subjectId);
  if (allPostIds.length > 0) {
    const ids = Array.from(new Set(allPostIds)).slice(0, MAX_ROWS);
    const { data: lines } = await supabase
      .from('gl_entry_lines')
      .select('gl_entry_id, debit_cents')
      .in('gl_entry_id', ids)
      .limit(MAX_ROWS * 4);
    for (const l of (lines ?? []) as Array<{ gl_entry_id: string; debit_cents: number | null }>) {
      glDebitByEntry.set(l.gl_entry_id, (glDebitByEntry.get(l.gl_entry_id) ?? 0) + Number(l.debit_cents ?? 0));
    }
  }
  const billTotalById = new Map<string, number>();
  if (allBillApproveIds.size > 0) {
    const { data: bills } = await supabase
      .from('bills')
      .select('id, total_cents')
      .in('id', Array.from(allBillApproveIds).slice(0, MAX_ROWS))
      .limit(MAX_ROWS);
    for (const b of (bills ?? []) as Array<{ id: string; total_cents: number | null }>) {
      billTotalById.set(b.id, Number(b.total_cents ?? 0));
    }
  }
  const invoiceTotalById = new Map<string, number>();
  if (allInvoiceSendIds.size > 0) {
    const { data: invs } = await supabase
      .from('invoices')
      .select('id, total_cents')
      .in('id', Array.from(allInvoiceSendIds).slice(0, MAX_ROWS))
      .limit(MAX_ROWS);
    for (const iv of (invs ?? []) as Array<{ id: string; total_cents: number | null }>) {
      invoiceTotalById.set(iv.id, Number(iv.total_cents ?? 0));
    }
  }

  // ── Q1 rework: gl_entries reversing a person's posted entries. ───────────────
  const reworkedOriginalIds = new Set<string>();
  if (allPostIds.length > 0) {
    const ids = Array.from(new Set(allPostIds)).slice(0, MAX_ROWS);
    const { data: reversals } = await supabase
      .from('gl_entries')
      .select('reversal_of_id')
      .in('reversal_of_id', ids)
      .limit(MAX_ROWS);
    for (const rv of (reversals ?? []) as Array<{ reversal_of_id: string | null }>) {
      if (rv.reversal_of_id) reworkedOriginalIds.add(rv.reversal_of_id);
    }
  }

  // ── Resolve display names (admin, id-scoped to org-derived ids). ─────────────
  const nameIds = new Set<string>(people.keys());

  // ── Close-schedule adherence (owner KPI #3) — team scope, trailing 12mo. ─────
  const closeSinceDate = new Date(Date.now() - CLOSE_LOOKBACK_MONTHS * 31 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  let close: unknown = null;
  if (scope === 'team') {
    const { data: periodRows } = await supabase
      .from('fiscal_periods')
      .select('id, location_id, period_year, period_month, end_date, status, closed_at')
      .eq('org_id', orgId)
      .gte('end_date', closeSinceDate)
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })
      .limit(500);
    const periods = (periodRows ?? []) as Array<{
      id: string;
      location_id: string;
      period_year: number;
      period_month: number;
      end_date: string;
      status: string;
      closed_at: string | null;
    }>;

    // Location names.
    const { data: locs } = await supabase
      .schema('core')
      .from('locations')
      .select('id, name, short_code');
    const locById = new Map<string, { name: string; short: string }>();
    for (const l of (locs ?? []) as Array<{ id: string; name: string | null; short_code: string | null }>) {
      locById.set(l.id, { name: l.name ?? 'Entity', short: l.short_code ?? '' });
    }

    // Close-owner: most-recent period.status actor per period (attribution spine).
    const closeOwnerByPeriod = new Map<string, string>();
    const { data: statusLog } = await supabase
      .schema('core')
      .from('action_log')
      .select('actor_user_id, subject_id, created_at')
      .eq('org_id', orgId)
      .eq('action', 'period.status')
      .gte('created_at', new Date(Date.now() - CLOSE_LOOKBACK_MONTHS * 31 * DAY_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(2000);
    for (const s of (statusLog ?? []) as Array<{ actor_user_id: string | null; subject_id: string | null }>) {
      if (s.subject_id && s.actor_user_id && !closeOwnerByPeriod.has(s.subject_id)) {
        closeOwnerByPeriod.set(s.subject_id, s.actor_user_id);
        nameIds.add(s.actor_user_id);
      }
    }

    const closeEvals: ClosePeriodEval[] = [];
    let openOverdueCount = 0;
    const closePeriodRows = periods.map((p) => {
      const dueDate = closeDueDateForPeriod(p.period_year, p.period_month, targets.closeBusinessDay);
      const closed = p.status === 'HARD_CLOSE' && !!p.closed_at;
      const onTime = closed ? isCloseOnTime(p.closed_at, dueDate) : null;
      const daysToClose = closed ? calendarDaysBetween(p.end_date, p.closed_at) : null;
      const openOverdue = !closed && Date.now() > dueDate.getTime() + DAY_MS - 1;
      if (openOverdue) openOverdueCount += 1;
      closeEvals.push({ closed, onTime, daysToClose });
      const loc = locById.get(p.location_id);
      return {
        periodId: p.id,
        label: `${p.period_year}-${String(p.period_month).padStart(2, '0')}`,
        entity: loc?.name ?? 'Entity',
        shortCode: loc?.short ?? '',
        status: p.status,
        dueDate: dueDate.toISOString().slice(0, 10),
        closedAt: p.closed_at,
        daysToClose,
        onTime,
        openOverdue,
        ownerUserId: closeOwnerByPeriod.get(p.id) ?? null,
      };
    });
    const closeRollup = rollupCloseAdherence(closeEvals);
    close = {
      lookbackMonths: CLOSE_LOOKBACK_MONTHS,
      targetBusinessDay: targets.closeBusinessDay,
      ...closeRollup,
      openOverdueCount,
      periods: closePeriodRows.slice(0, 36),
    };
  }

  // ── Filing-schedule adherence (owner KPI #4) — team scope. ───────────────────
  interface FilingRow {
    source: string;
    label: string;
    jurisdiction: string;
    dueDate: string;
    filedAt: string | null;
    status: 'filed' | 'overdue' | 'due-soon' | 'upcoming';
    onTime: boolean | null;
  }
  let filing: unknown = null;
  if (scope === 'team') {
    const filingEvals: FilingEval[] = [];
    const filingRows: FilingRow[] = [];
    let salesTaxAvailable = false;

    // (a) Sales/use-tax filing calendar (reuses the existing report engine).
    try {
      const report = await buildSalesTaxCalendar(supabase, orgId, {
        lookbackMonths: CLOSE_LOOKBACK_MONTHS,
        lookaheadMonths: FILING_LOOKAHEAD_MONTHS,
      });
      salesTaxAvailable = report.filingsAvailable;
      for (const j of report.jurisdictions) {
        for (const row of j.rows) {
          const filed = row.status === 'filed';
          const onTime = filed ? isFilingOnTime(row.filedAt, row.dueDate, targets.filingGraceDays) : null;
          filingEvals.push({ filed, onTime, overdue: row.status === 'overdue' });
          filingRows.push({
            source: 'Sales tax',
            label: `${j.jurisdiction} · ${row.label}`,
            jurisdiction: j.jurisdiction,
            dueDate: row.dueDate,
            filedAt: row.filedAt,
            status: row.status,
            onTime,
          });
        }
      }
    } catch {
      salesTaxAvailable = false;
    }

    // (b) Generic regulatory obligations (940/941/withholding/1099/etc.).
    try {
      const { data: cf } = await supabase
        .from('compliance_filings')
        .select('due_date, filed_at, status, period_year, period_month, period_quarter, compliance_obligations(name, jurisdiction, frequency)')
        .eq('org_id', orgId)
        .gte('due_date', closeSinceDate)
        .order('due_date', { ascending: false })
        .limit(500);
      for (const f of (cf ?? []) as Array<{
        due_date: string;
        filed_at: string | null;
        status: string;
        period_year: number | null;
        period_month: number | null;
        period_quarter: number | null;
        compliance_obligations: { name?: string; jurisdiction?: string } | { name?: string; jurisdiction?: string }[] | null;
      }>) {
        const ob = Array.isArray(f.compliance_obligations) ? f.compliance_obligations[0] : f.compliance_obligations;
        const filed = f.status === 'FILED' || f.status === 'AUTO_VERIFIED';
        const overdue = !filed && Date.parse(f.due_date) < Date.now();
        const onTime = filed ? isFilingOnTime(f.filed_at, f.due_date, targets.filingGraceDays) : null;
        const periodLabel =
          f.period_month != null
            ? `${f.period_year}-${String(f.period_month).padStart(2, '0')}`
            : f.period_quarter != null
              ? `${f.period_year} Q${f.period_quarter}`
              : `${f.period_year ?? ''}`;
        filingEvals.push({ filed, onTime, overdue });
        filingRows.push({
          source: ob?.name ?? 'Filing',
          label: `${ob?.name ?? 'Filing'} · ${periodLabel}`.trim(),
          jurisdiction: ob?.jurisdiction ?? '',
          dueDate: f.due_date,
          filedAt: f.filed_at,
          status: filed ? 'filed' : overdue ? 'overdue' : 'upcoming',
          onTime,
        });
      }
    } catch {
      /* compliance_filings absent → sales-tax-only filing view. */
    }

    const filingRollup = rollupFilingAdherence(filingEvals);
    const upcoming = filingRows
      .filter((r) => r.status === 'due-soon' || r.status === 'upcoming' || r.status === 'overdue')
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 8);
    const history = filingRows
      .filter((r) => r.status === 'filed')
      .sort((a, b) => b.dueDate.localeCompare(a.dueDate))
      .slice(0, 12);
    filing = {
      lookbackMonths: CLOSE_LOOKBACK_MONTHS,
      salesTaxAvailable,
      ...filingRollup,
      upcoming,
      history,
    };
  }

  // ── Resolve names for everyone referenced (people + close owners). ───────────
  const nameById = new Map<string, string>();
  if (nameIds.size > 0) {
    const admin = createAdminSupabase();
    const { data: users } = await admin
      .schema('core')
      .from('users')
      .select('id, first_name, last_name, email')
      .in('id', Array.from(nameIds));
    for (const u of (users ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>) {
      const full = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
      nameById.set(u.id, full || u.email || 'Team member');
    }
  }

  // Backfill close-owner display names now that nameById is resolved.
  if (close && typeof close === 'object') {
    const c = close as { periods: Array<{ ownerUserId: string | null; ownerName?: string | null }> };
    for (const row of c.periods) {
      (row as { ownerName?: string | null }).ownerName = row.ownerUserId
        ? nameById.get(row.ownerUserId) ?? null
        : null;
    }
  }

  // ── Assemble per-person scorecards. ──────────────────────────────────────────
  const scorecardInputs: ScorecardInput[] = [];
  const personIds = Array.from(people.keys());
  const cards = personIds.map((uid) => {
    const acc = people.get(uid)!;
    const throughput = computeThroughput(acc.actions, catalog);

    // Dollars processed, per family.
    const dollarItems: DollarItem[] = [];
    for (const sid of acc.postSubjectIds) {
      const cents = glDebitByEntry.get(sid);
      if (cents) dollarItems.push({ family: 'journal' as DollarFamily, cents });
    }
    for (const bid of acc.billApproveIds) {
      const cents = billTotalById.get(bid);
      if (cents) dollarItems.push({ family: 'bill' as DollarFamily, cents });
    }
    for (const iid of acc.invoiceSendIds) {
      const cents = invoiceTotalById.get(iid);
      if (cents) dollarItems.push({ family: 'invoice' as DollarFamily, cents });
    }
    if (acc.payrollCents > 0) dollarItems.push({ family: 'payroll' as DollarFamily, cents: acc.payrollCents });
    if (acc.paymentsCents > 0) dollarItems.push({ family: 'payments' as DollarFamily, cents: acc.paymentsCents });
    const dollars = computeDollars(dollarItems);

    const overrideRate = safeRate(acc.overrides, acc.approvedTxns);
    let reworked = 0;
    for (const sid of acc.postSubjectIds) if (reworkedOriginalIds.has(sid)) reworked += 1;
    const reworkRate = safeRate(reworked, acc.posts);
    const name = nameById.get(uid) ?? 'Team member';

    scorecardInputs.push({
      userId: uid,
      name,
      throughput,
      overrideRate,
      overrideSample: acc.approvedTxns,
      reworkRate,
      reworkSample: acc.posts,
    });

    const activeDays = new Set(acc.allActionDates.map((d) => d.slice(0, 10))).size;

    return {
      userId: uid,
      name,
      throughput,
      dollars,
      cycleTime: {
        uploadToCategorizedHrsAvg: msToHours(averageLatencyMs(acc.uploadToCategorized)),
        categorizedToApprovedHrsAvg: msToHours(averageLatencyMs(acc.categorizedToApproved)),
        approvalLatencyHrsAvg: msToHours(averageLatencyMs(acc.approvalLatency)),
        approvalLatencyHrsMedian: msToHours(medianLatencyMs(acc.approvalLatency)),
      },
      quality: {
        overrideRate,
        overrideSample: acc.approvedTxns,
        reworkRate,
        reworkSample: acc.posts,
        qualityFlag: reworkRate != null && reworkRate > targets.reworkGate,
      },
      engagement: {
        activeDays,
        lastActive: acc.lastActive,
      },
    };
  });

  cards.sort((a, b) => b.throughput.composite - a.throughput.composite);

  // ── Team roll-up + KPI headline + leaderboard (manager scope only). ──────────
  let kpis: unknown = null;
  let leaderboard: { entries: LeaderboardEntry[]; topPerformerUserId: string | null } | null = null;

  if (scope === 'team') {
    const totalActors = actorSplit.HUMAN + actorSplit.AI + actorSplit.SYSTEM;
    const teamComposite = Math.round(cards.reduce((s, c) => s + c.throughput.composite, 0) * 1000) / 1000;
    const teamActions = cards.reduce((s, c) => s + c.throughput.totalActions, 0);
    const teamDollars = cards.reduce((s, c) => s + c.dollars.totalCents, 0);

    const allAppr: Array<number | null> = [];
    for (const acc of people.values()) allAppr.push(...acc.approvalLatency);

    leaderboard = buildLeaderboard(scorecardInputs, targets);

    const closeObj = close as { onTimePct: number | null } | null;
    const filingObj = filing as { onTimePct: number | null } | null;

    kpis = {
      activePeople: cards.length,
      weightedThroughput: teamComposite,
      totalActions: teamActions,
      dollarsProcessedCents: teamDollars,
      avgCycleTimeHours: msToHours(medianLatencyMs(allAppr)),
      closeOnTimePct: closeObj?.onTimePct ?? null,
      filingOnTimePct: filingObj?.onTimePct ?? null,
      aiSharePct: totalActors > 0 ? Math.round((actorSplit.AI / totalActors) * 1000) / 10 : null,
    };
  }

  return NextResponse.json({
    scope,
    period: { days, since: sinceIso, label: `Last ${days} days` },
    targets: { reworkGate: targets.reworkGate, overrideWatch: targets.overrideWatch, closeBusinessDay: targets.closeBusinessDay },
    kpis,
    people: cards,
    leaderboard,
    close,
    filing,
    needsCentral: NEEDS_CENTRAL,
  });
}
