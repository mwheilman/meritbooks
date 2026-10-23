/**
 * Monthly WIP run — I/O orchestration over the pure canonical engine (wip-engine.ts).
 * FPB-rev-rec-wip §4–§5.
 *
 *   loadWipSchedule   compute the schedule for one company + month (read-only): every job's
 *                     line, the proposed entries, totals, the tie-out to GL 1180 / 2410 / 2450,
 *                     the prior-month comparison, and the run status + history.
 *   proposeWipRun     save the computation as a PROPOSED run (superseding an older proposal);
 *                     NO_CHANGE when there is nothing to book.
 *   postWipRun        human approval (or the scheduler under the autonomy dial): recompute,
 *                     refuse if the numbers moved since the proposal, then post the billings
 *                     reclass, the WIP adjustment and its reversal dated the 1st of next month.
 *   dismissWipRun     close the month's review without posting — a reason is required.
 *   retryWipReversal  post a reversal that failed the first time (next month not open yet).
 *
 * Reads run through the caller's client (RLS-scoped; tenant isolation by the DB). Writes to
 * the locked tables (migration 179; gl via postJournalEntry) go through scopedWriter — the
 * service role after the route's permission check, org pinned, the company asserted in the
 * caller's client scope. Accounts resolve BY ROLE. All money is bigint cents.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { scopedWriter } from '@/lib/db/scoped-writer';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import { postJournalEntry, type JournalEntryLineInput } from '@/lib/services/gl-posting';
import { resolveRevRecMethod, type JobRevRecRow, type RevRecMethod } from '@/lib/services/rev-rec';
import {
  buildWipEntries,
  computeTieOut,
  computeWipLine,
  nextPeriodStart,
  periodEnd,
  priorPeriodKey,
  totalsOf,
  wipSourceRefs,
  WIP_RECLASS_SOURCE_MODULE,
  WIP_SOURCE_MODULE,
  ZERO_BALANCES,
  type JobWipBalances,
  type TieOut,
  type WipAccounts,
  type WipEntries,
  type WipLine,
  type WipTotals,
} from './wip-engine';
import {
  policyFromRow,
  resolveJobPolicy,
  type CompanyRevRecPolicy,
  type RevRecPolicyRow,
  type SwitchOverride,
} from './policy';

type DB = SupabaseClient;

export type WipRunStatus = 'PROPOSED' | 'POSTING' | 'POSTED' | 'DISMISSED' | 'SUPERSEDED' | 'NO_CHANGE' | 'FAILED';

/** A POSTING claim older than this is treated as an interrupted post (the process died mid-post). */
export const POSTING_CLAIM_STALE_MS = 10 * 60_000;
export type WipRunSource = 'MANUAL' | 'SCHEDULER';

/** Job statuses the run carries (plus any job — even closed — still holding a WIP balance). */
export const WIP_JOB_STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETE'] as const;

const JOB_SELECT =
  'id, job_number, name, location_id, job_type, archetype, status, rev_rec_method, rev_rec_method_override, ' +
  'revenue_account_id, contract_amount_cents, estimated_cost_cents, actual_cost_cents, billed_to_date_cents, ' +
  'retainage_held_cents, pct_complete, revenue_recognized_cents, service_start_date, service_end_date, ' +
  'total_milestones, completed_milestones';

type JobRow = JobRevRecRow & { job_number: string | null; name: string | null; retainage_held_cents: number | null };

export interface WipRunRow {
  id: string;
  org_id: string;
  location_id: string;
  period_key: string;
  as_of_date: string;
  revision: number;
  status: WipRunStatus;
  source: WipRunSource;
  job_count: number;
  underbilled_cents: number;
  overbilled_cents: number;
  loss_provision_cents: number;
  net_revenue_adjustment_cents: number;
  reclass_cents: number;
  gross_adjustment_cents: number;
  gl_unbilled_cents: number | null;
  gl_deferred_cents: number | null;
  requested_by: string | null;
  proposed_at: string;
  approved_by: string | null;
  posted_at: string | null;
  wip_entry_id: string | null;
  reversal_entry_id: string | null;
  reclass_entry_id: string | null;
  reversal_pending: boolean;
  dismissed_by: string | null;
  dismissed_at: string | null;
  dismiss_reason: string | null;
  error: string | null;
  updated_at?: string | null;
}

const RUN_SELECT =
  'id, org_id, location_id, period_key, as_of_date, revision, status, source, job_count, underbilled_cents, ' +
  'overbilled_cents, loss_provision_cents, net_revenue_adjustment_cents, reclass_cents, gross_adjustment_cents, ' +
  'gl_unbilled_cents, gl_deferred_cents, requested_by, proposed_at, approved_by, posted_at, wip_entry_id, ' +
  'reversal_entry_id, reclass_entry_id, reversal_pending, dismissed_by, dismissed_at, dismiss_reason, error, updated_at';

export interface PeriodState {
  status: 'OPEN' | 'SOFT_CLOSE' | 'HARD_CLOSE' | 'MISSING';
}

export interface WipSchedule {
  locationId: string;
  company: { name: string; shortCode: string; defaultMethod: RevRecMethod } | null;
  periodKey: string;
  asOf: string;
  reversalDate: string;
  policy: CompanyRevRecPolicy;
  policyRowExists: boolean;
  lines: WipLine[];
  entries: WipEntries;
  totals: WipTotals;
  tieOut: TieOut | null;
  /** Account numbers used (by role) — for the "what will post" panel. */
  accounts: { unbilled: string | null; deferred: string | null; lossProvision: string | null; lossExpense: string | null };
  /** Blocking setup problems (an unresolved required role). Empty = ready. */
  setupIssues: string[];
  period: PeriodState;
  nextPeriod: PeriodState;
  /** Latest live run for this month (PROPOSED wins, else the newest non-superseded). */
  currentRun: WipRunRow | null;
  /** Prior month's run totals, for the comparison strip. */
  priorRun: WipRunRow | null;
  history: WipRunRow[];
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// ─────────────────────────────────────────────────────────────────────────────
// Loaders
// ─────────────────────────────────────────────────────────────────────────────

export async function loadCompanyPolicy(db: DB, orgId: string, locationId: string): Promise<{ policy: CompanyRevRecPolicy; exists: boolean }> {
  const { data } = await db
    .from('rev_rec_policies')
    .select('accrue_underbillings, defer_overbillings, loss_provision, run_cadence, posting_mode, materiality_cents, retainage_presentation')
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .maybeSingle();
  return { policy: policyFromRow(data as RevRecPolicyRow | null), exists: !!data };
}

async function loadPeriodState(db: DB, orgId: string, locationId: string, date: string): Promise<PeriodState> {
  const { data } = await db
    .from('fiscal_periods')
    .select('status')
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .lte('start_date', date)
    .gte('end_date', date)
    .maybeSingle();
  const s = (data as { status: PeriodState['status'] } | null)?.status;
  return { status: s ?? 'MISSING' };
}

async function fallbackRevenueAccount(db: DB, orgId: string): Promise<string | null> {
  const { data } = await db
    .from('accounts')
    .select('id, name')
    .eq('org_id', orgId)
    .eq('account_type', 'REVENUE')
    .eq('is_active', true)
    .order('account_number', { ascending: true });
  const rows = (data ?? []) as { id: string; name: string }[];
  if (rows.length === 0) return null;
  return (rows.find((r) => /contract|service|sales|operating|revenue/i.test(r.name)) ?? rows[0]).id;
}

interface GlAgg {
  byJob: Map<string, JobWipBalances>;
  /** Σ job-attributed balances (all jobs of the company) — the tie-out's GL side. */
  jobs: { unbilled: number; deferred: number; loss: number };
  other: { unbilled: number; deferred: number; loss: number };
}

/** POSTED lines on 1180 / 2410 / 2450 for the company, dated ≤ asOf, split WIP vs permanent. */
async function loadGlBalances(
  db: DB,
  orgId: string,
  locationId: string,
  asOf: string,
  ids: { unbilled: string; deferred: string; loss: string | null },
): Promise<GlAgg> {
  const accountIds = [ids.unbilled, ids.deferred, ...(ids.loss ? [ids.loss] : [])];
  const { data, error } = await fetchAll(
    () =>
      db
        .from('gl_entry_lines')
        .select('id, account_id, job_id, debit_cents, credit_cents, gl_entries!inner(entry_date, status, source_module)')
        .eq('org_id', orgId)
        .eq('location_id', locationId)
        .in('account_id', accountIds)
        .eq('gl_entries.status', 'POSTED')
        .lte('gl_entries.entry_date', asOf),
    { label: 'wip-run gl_entry_lines' },
  );
  if (error) throw new Error(`Could not read the GL: ${error.message}`);

  const out: GlAgg = { byJob: new Map(), jobs: { unbilled: 0, deferred: 0, loss: 0 }, other: { unbilled: 0, deferred: 0, loss: 0 } };
  type Row = {
    account_id: string; job_id: string | null; debit_cents: number | string; credit_cents: number | string;
    gl_entries: { source_module: string | null } | { source_module: string | null }[] | null;
  };
  for (const r of (data ?? []) as Row[]) {
    const entry = Array.isArray(r.gl_entries) ? r.gl_entries[0] : r.gl_entries;
    const isWip = entry?.source_module === WIP_SOURCE_MODULE;
    const dr = num(r.debit_cents) - num(r.credit_cents); // debit-positive
    const kind = r.account_id === ids.unbilled ? 'unbilled' : r.account_id === ids.deferred ? 'deferred' : 'loss';
    const signed = kind === 'unbilled' ? dr : -dr; // liabilities credit-positive
    if (!r.job_id) {
      out.other[kind] += signed;
      continue;
    }
    out.jobs[kind] += signed;
    const b = out.byJob.get(r.job_id) ?? { ...ZERO_BALANCES };
    if (kind === 'unbilled') {
      if (isWip) b.wipUnbilledCents += signed; else b.permUnbilledCents += signed;
    } else if (kind === 'deferred') {
      if (isWip) b.wipDeferredCents += signed; else b.permDeferredCents += signed;
    } else if (isWip) {
      b.wipLossCents += signed;
    }
    out.byJob.set(r.job_id, b);
  }
  return out;
}

/** Latest run per (period) — PROPOSED wins, else the highest live revision. */
function pickCurrent(runs: WipRunRow[]): WipRunRow | null {
  const live = runs.filter((r) => r.status !== 'SUPERSEDED');
  return live.find((r) => r.status === 'PROPOSED') ?? live.sort((a, b) => b.revision - a.revision)[0] ?? null;
}

async function loadRuns(db: DB, orgId: string, locationId: string, periodKeys: string[]): Promise<WipRunRow[]> {
  const { data } = await db
    .from('rev_rec_wip_runs')
    .select(RUN_SELECT)
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .in('period_key', periodKeys)
    .order('revision', { ascending: false });
  return (data ?? []) as unknown as WipRunRow[];
}

export async function listWipRuns(db: DB, orgId: string, locationId: string, limit = 24): Promise<WipRunRow[]> {
  const { data } = await db
    .from('rev_rec_wip_runs')
    .select(RUN_SELECT)
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .order('period_key', { ascending: false })
    .order('revision', { ascending: false })
    .limit(limit);
  return (data ?? []) as unknown as WipRunRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule
// ─────────────────────────────────────────────────────────────────────────────

export async function loadWipSchedule(
  db: DB,
  orgId: string,
  args: { locationId: string; periodKey: string },
): Promise<WipSchedule> {
  const { locationId, periodKey } = args;
  const asOf = periodEnd(periodKey);
  const priorKey = priorPeriodKey(periodKey);

  const [{ policy, exists }, locRes, mapRes, revTypeRes, overrideRes, jobsRes, runs, history, period, nextPeriod] = await Promise.all([
    loadCompanyPolicy(db, orgId, locationId),
    db.schema('core').from('locations').select('name, short_code, rev_rec_method').eq('id', locationId).maybeSingle(),
    db.from('rev_rec_method_map').select('job_type, method, accrue_underbillings, defer_overbillings').eq('org_id', orgId).eq('location_id', locationId),
    db.from('revenue_type_methods').select('revenue_account_id, method').eq('org_id', orgId).eq('location_id', locationId),
    db.from('rev_rec_job_overrides').select('job_id, accrue_underbillings, defer_overbillings, exclude_from_wip').eq('org_id', orgId).eq('location_id', locationId),
    fetchAll(
      () => db.schema('core').from('jobs').select(JOB_SELECT).eq('org_id', orgId).eq('location_id', locationId).in('status', [...WIP_JOB_STATUSES]),
      { label: 'wip-run jobs' },
    ),
    loadRuns(db, orgId, locationId, [periodKey, priorKey]),
    listWipRuns(db, orgId, locationId, 12),
    loadPeriodState(db, orgId, locationId, asOf),
    loadPeriodState(db, orgId, locationId, nextPeriodStart(periodKey)),
  ]);

  const loc = locRes.data as { name: string; short_code: string; rev_rec_method: RevRecMethod | null } | null;
  const companyDefault: RevRecMethod = loc?.rev_rec_method ?? 'PCT_COSTS_INCURRED';

  type MapRow = { job_type: string; method: RevRecMethod; accrue_underbillings: boolean | null; defer_overbillings: boolean | null };
  const mapRows = (mapRes.data ?? []) as MapRow[];
  const jobTypeMethod = new Map(mapRows.map((r) => [r.job_type, r.method]));
  const jobTypeSwitch = new Map<string, SwitchOverride>(
    mapRows.map((r) => [r.job_type, { accrueUnderbillings: r.accrue_underbillings, deferOverbillings: r.defer_overbillings }]),
  );
  const revTypeMap = new Map(
    ((revTypeRes.data ?? []) as { revenue_account_id: string; method: RevRecMethod }[]).map((r) => [r.revenue_account_id, r.method]),
  );
  type OverrideRow = { job_id: string; accrue_underbillings: boolean | null; defer_overbillings: boolean | null; exclude_from_wip: boolean };
  const overrides = new Map(((overrideRes.data ?? []) as OverrideRow[]).map((r) => [r.job_id, r]));

  // Accounts by role. 1180 + 2410 are required; the loss pair is optional (reported).
  const setupIssues: string[] = [];
  let unbilled: { id: string; account_number: string } | null = null;
  let deferred: { id: string; account_number: string } | null = null;
  let lossProvision: { id: string; account_number: string } | null = null;
  let lossExpense: { id: string; account_number: string } | null = null;
  try { unbilled = await resolveRole(db, orgId, 'UNBILLED_RECEIVABLE'); } catch (e) { setupIssues.push(e instanceof PostingError ? e.message : 'Unbilled receivable (1180) is not set up'); }
  try { deferred = await resolveRole(db, orgId, 'DEFERRED_REVENUE'); } catch (e) { setupIssues.push(e instanceof PostingError ? e.message : 'Deferred revenue (2410) is not set up'); }
  if (policy.lossProvision) {
    try { lossProvision = await resolveRole(db, orgId, 'CONTRACT_LOSS_PROVISION'); } catch { lossProvision = null; }
    try { lossExpense = await resolveRole(db, orgId, 'CONTRACT_LOSS_EXPENSE'); } catch { lossExpense = null; }
  }

  const gl = unbilled && deferred
    ? await loadGlBalances(db, orgId, locationId, asOf, { unbilled: unbilled.id, deferred: deferred.id, loss: lossProvision?.id ?? null })
    : null;

  // Jobs: the open set + any other job still carrying a WIP balance (e.g. closed this month).
  const jobs = ((jobsRes.data ?? []) as unknown as JobRow[]).slice();
  if (gl) {
    const have = new Set(jobs.map((j) => j.id));
    const missing = [...gl.byJob.entries()]
      .filter(([id, b]) => !have.has(id) && (b.permUnbilledCents || b.permDeferredCents || b.wipUnbilledCents || b.wipDeferredCents || b.wipLossCents))
      .map(([id]) => id);
    if (missing.length > 0) {
      const { data } = await db.schema('core').from('jobs').select(JOB_SELECT).eq('org_id', orgId).in('id', missing);
      jobs.push(...((data ?? []) as unknown as JobRow[]));
    }
  }

  const methodOf = (j: JobRow) => resolveRevRecMethod(j, jobTypeMethod, companyDefault, revTypeMap);

  // Cash collected (CASH method only).
  const collected = new Map<string, number>();
  const cashJobs = jobs.filter((j) => methodOf(j) === 'CASH').map((j) => j.id);
  if (cashJobs.length > 0) {
    const { data } = await db.from('invoices').select('job_id, amount_paid_cents').eq('org_id', orgId).in('job_id', cashJobs);
    for (const r of (data ?? []) as { job_id: string; amount_paid_cents: number | null }[]) {
      collected.set(r.job_id, (collected.get(r.job_id) ?? 0) + num(r.amount_paid_cents));
    }
  }

  // Prior month's estimated GP per job (fade / gain).
  const priorRun = pickCurrent(runs.filter((r) => r.period_key === priorKey));
  const priorGp = new Map<string, number>();
  if (priorRun) {
    const { data } = await db.from('rev_rec_wip_run_lines').select('job_id, est_gross_profit_cents').eq('run_id', priorRun.id);
    for (const r of (data ?? []) as { job_id: string; est_gross_profit_cents: number }[]) priorGp.set(r.job_id, num(r.est_gross_profit_cents));
  }

  const lines = jobs
    .map((j) => {
      const o = overrides.get(j.id);
      const typeKey = j.job_type ?? j.archetype ?? null;
      const resolved = resolveJobPolicy({
        company: policy,
        companyRowExists: exists,
        jobType: typeKey ? jobTypeSwitch.get(typeKey) ?? null : null,
        job: o ? { accrueUnderbillings: o.accrue_underbillings, deferOverbillings: o.defer_overbillings, excludeFromWip: o.exclude_from_wip } : null,
      });
      return computeWipLine(
        {
          job: j,
          method: methodOf(j),
          policy: resolved,
          balances: gl?.byJob.get(j.id) ?? ZERO_BALANCES,
          collectedToDateCents: collected.get(j.id) ?? 0,
          priorEstGrossProfitCents: priorGp.has(j.id) ? priorGp.get(j.id)! : null,
        },
        { asOf, lossProvision: policy.lossProvision, materialityCents: policy.materialityCents },
      );
    })
    .sort((a, b) => (a.jobNumber ?? '').localeCompare(b.jobNumber ?? ''));

  const accounts: WipAccounts | null = unbilled && deferred
    ? {
        unbilledId: unbilled.id,
        deferredId: deferred.id,
        lossProvisionId: lossProvision && lossExpense ? lossProvision.id : null,
        lossExpenseId: lossProvision && lossExpense ? lossExpense.id : null,
        fallbackRevenueId: await fallbackRevenueAccount(db, orgId),
      }
    : null;
  const entries: WipEntries = accounts ? buildWipEntries(lines, accounts) : { adjustment: [], reversal: [], reclass: [], issues: [] };
  const totals = totalsOf(lines, entries);
  const tieOut = gl
    ? computeTieOut({
        lines,
        gl: {
          unbilledJobs: gl.jobs.unbilled, unbilledOther: gl.other.unbilled,
          deferredJobs: gl.jobs.deferred, deferredOther: gl.other.deferred,
          lossJobs: gl.jobs.loss, lossOther: gl.other.loss,
        },
      })
    : null;

  return {
    locationId,
    company: loc ? { name: loc.name, shortCode: loc.short_code, defaultMethod: companyDefault } : null,
    periodKey,
    asOf,
    reversalDate: nextPeriodStart(periodKey),
    policy,
    policyRowExists: exists,
    lines,
    entries,
    totals,
    tieOut,
    accounts: {
      unbilled: unbilled?.account_number ?? null,
      deferred: deferred?.account_number ?? null,
      lossProvision: lossProvision?.account_number ?? null,
      lossExpense: lossExpense?.account_number ?? null,
    },
    setupIssues,
    period,
    nextPeriod,
    currentRun: pickCurrent(runs.filter((r) => r.period_key === periodKey)),
    priorRun,
    history,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Propose
// ─────────────────────────────────────────────────────────────────────────────

export class WipRunError extends Error {
  constructor(message: string, readonly status: number = 422, readonly code: string = 'WIP_RUN_ERROR') {
    super(message);
    this.name = 'WipRunError';
  }
}

/** A stable fingerprint of what a schedule would post (stale-proposal guard). */
export function postingFingerprint(lines: ReadonlyArray<Pick<WipLine, 'jobId' | 'adjUnbilledCents' | 'adjDeferredCents' | 'adjLossCents' | 'reclassRevenueCents' | 'excluded'>>): string {
  return lines
    .filter((l) => !l.excluded && (l.adjUnbilledCents || l.adjDeferredCents || l.adjLossCents || l.reclassRevenueCents))
    .map((l) => `${l.jobId}:${l.adjUnbilledCents}:${l.adjDeferredCents}:${l.adjLossCents}:${l.reclassRevenueCents}`)
    .sort()
    .join('|');
}

function hasSomethingToPost(s: WipSchedule): boolean {
  return s.entries.adjustment.length > 0 || s.entries.reclass.length > 0;
}

export interface ProposeResult {
  run: WipRunRow | null;
  schedule: WipSchedule;
  /** 'proposed' | 'no_change' (recorded) | 'up_to_date' (already posted, nothing new) | 'no_jobs'. */
  outcome: 'proposed' | 'no_change' | 'up_to_date' | 'no_jobs';
}

/**
 * Save the month's computation as a PROPOSED run (or NO_CHANGE). An older PROPOSED run for the
 * same month is SUPERSEDED. A month already POSTED with nothing new returns 'up_to_date'.
 */
export async function proposeWipRun(
  db: DB,
  orgId: string,
  args: { locationId: string; periodKey: string; requestedBy: string | null; source: WipRunSource; schedule?: WipSchedule },
): Promise<ProposeResult> {
  const schedule = args.schedule ?? (await loadWipSchedule(db, orgId, args));
  if (schedule.setupIssues.length > 0) throw new WipRunError(schedule.setupIssues[0], 422, 'ACCOUNT_ROLE_UNRESOLVED');
  if (schedule.lines.length === 0) return { run: null, schedule, outcome: 'no_jobs' };

  const existing = await loadRuns(db, orgId, args.locationId, [args.periodKey]);
  const something = hasSomethingToPost(schedule);
  const posted = existing.some((r) => r.status === 'POSTED');
  if (!something && posted) return { run: schedule.currentRun, schedule, outcome: 'up_to_date' };

  const writer = await scopedWriter(db, orgId, [args.locationId]);

  // An approval is posting this month right now: don't race it with a new proposal. A claim
  // left behind by a post that died mid-way is released (FAILED) so the month can move on.
  for (const r of existing.filter((x) => x.status === 'POSTING')) {
    const age = Date.now() - new Date(r.updated_at ?? r.proposed_at).getTime();
    if (age < POSTING_CLAIM_STALE_MS) {
      throw new WipRunError('This month’s WIP entry is being posted right now. Refresh in a moment.', 409, 'POSTING_IN_PROGRESS');
    }
    await writer.from('rev_rec_wip_runs')
      .update({ status: 'FAILED', error: 'Posting was interrupted before it finished. Review the journal entries, then propose again.', updated_at: new Date().toISOString() })
      .eq('org_id', orgId).eq('id', r.id).eq('status', 'POSTING');
  }

  // Supersede the open proposal (one PROPOSED per company + month — partial unique index).
  const open = existing.filter((r) => r.status === 'PROPOSED').map((r) => r.id);
  if (open.length > 0) {
    const { error } = await writer.from('rev_rec_wip_runs').update({ status: 'SUPERSEDED' }).eq('org_id', orgId).in('id', open);
    if (error) throw new WipRunError(`Could not replace the earlier proposal: ${error.message}`, 500);
  }
  const revision = existing.reduce((m, r) => Math.max(m, r.revision), 0) + 1;
  const t = schedule.totals;

  const { data: inserted, error } = await writer
    .from('rev_rec_wip_runs')
    .insert({
      org_id: orgId,
      location_id: args.locationId,
      period_key: args.periodKey,
      as_of_date: schedule.asOf,
      revision,
      status: something ? 'PROPOSED' : 'NO_CHANGE',
      source: args.source,
      job_count: schedule.lines.length,
      underbilled_cents: t.targetUnderCents,
      overbilled_cents: t.targetOverCents,
      loss_provision_cents: t.targetLossCents,
      net_revenue_adjustment_cents: t.adjRevenueCents,
      reclass_cents: t.reclassRevenueCents,
      gross_adjustment_cents: t.grossAdjustmentCents,
      gl_unbilled_cents: schedule.tieOut?.unbilled.glJobsCents ?? null,
      gl_deferred_cents: schedule.tieOut?.deferred.glJobsCents ?? null,
      policy_snapshot: { ...schedule.policy, fingerprint: postingFingerprint(schedule.lines) },
      requested_by: args.requestedBy,
    })
    .select(RUN_SELECT)
    .single();
  if (error || !inserted) throw new WipRunError(`Could not save the proposal: ${error?.message ?? 'unknown'}`, 500);
  const run = inserted as unknown as WipRunRow;

  const rows = schedule.lines.map((l) => ({
    org_id: orgId,
    run_id: run.id,
    location_id: args.locationId,
    job_id: l.jobId,
    job_number: l.jobNumber,
    job_name: l.jobName,
    method: l.method,
    contract_cents: l.contractCents,
    eac_cents: l.eacCents,
    cost_to_date_cents: l.costToDateCents,
    pct_complete: l.pctComplete,
    earned_cents: l.earnedCents,
    billed_cents: l.billedCents,
    retainage_cents: l.retainageCents,
    under_cents: l.underCents,
    over_cents: l.overCents,
    loss_provision_cents: l.lossProvisionCents,
    est_gross_profit_cents: l.estGrossProfitCents,
    prior_est_gross_profit_cents: l.priorEstGrossProfitCents,
    fade_gain_cents: l.fadeGainCents,
    perm_unbilled_cents: l.balances.permUnbilledCents,
    perm_deferred_cents: l.balances.permDeferredCents,
    adj_unbilled_cents: l.adjUnbilledCents,
    adj_deferred_cents: l.adjDeferredCents,
    adj_loss_cents: l.adjLossCents,
    adj_revenue_cents: l.adjRevenueCents,
    reclass_revenue_cents: l.reclassRevenueCents,
    below_materiality: l.belowMateriality,
    accrue_underbillings: l.policy.accrueUnderbillings,
    defer_overbillings: l.policy.deferOverbillings,
    policy_source: { ...l.policy.source, excluded: l.excluded },
  }));
  if (rows.length > 0) {
    const { error: lineErr } = await writer.from('rev_rec_wip_run_lines').insert(rows);
    if (lineErr) throw new WipRunError(`Could not save the job detail: ${lineErr.message}`, 500);
  }

  return { run, schedule, outcome: something ? 'proposed' : 'no_change' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Post (approve)
// ─────────────────────────────────────────────────────────────────────────────

async function loadRun(db: DB, orgId: string, runId: string): Promise<WipRunRow> {
  const { data } = await db.from('rev_rec_wip_runs').select(RUN_SELECT).eq('org_id', orgId).eq('id', runId).maybeSingle();
  if (!data) throw new WipRunError('Proposal not found', 404, 'NOT_FOUND');
  return data as unknown as WipRunRow;
}

export interface PostResult {
  run: WipRunRow;
  entryNumbers: { adjustment?: string; reversal?: string; reclass?: string };
  reversalPending: boolean;
}

/**
 * Post an approved proposal. The schedule is recomputed first; if what would post differs
 * from what was proposed (an invoice or cost landed since), the proposal is superseded by a
 * fresh one and the call is refused (409) so a human approves the current numbers.
 */
/** The separation-of-duties verdict the route supplies (lib/rbac/je-post-sod). */
export type WipSodVerdict = { ok: true } | { ok: false; status: number; error: string; code: string };

export async function postWipRun(
  db: DB,
  orgId: string,
  args: { runId: string; approvedBy: string | null; sod?: (run: WipRunRow) => Promise<WipSodVerdict> },
): Promise<PostResult> {
  const run = await loadRun(db, orgId, args.runId);
  if (run.status !== 'PROPOSED') throw new WipRunError(`This proposal is ${run.status.toLowerCase().replace('_', ' ')} — nothing to approve`, 409, 'NOT_PROPOSED');

  // Separation of duties (H6_JE_SELF_POST): the route's check, run with the proposer as the
  // preparer, before anything is claimed or posted.
  if (args.sod) {
    const verdict = await args.sod(run);
    if (!verdict.ok) throw new WipRunError(verdict.error, verdict.status, verdict.code);
  }

  const writer = await scopedWriter(db, orgId, [run.location_id]);

  // CLAIM the run (PROPOSED → POSTING) before posting anything. Two approvers clicking at
  // once both pass the status check above; only one wins this conditional update — the
  // other gets 409 and posts nothing.
  const { data: claimed, error: claimErr } = await writer
    .from('rev_rec_wip_runs')
    .update({ status: 'POSTING', error: null, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', run.id)
    .eq('status', 'PROPOSED')
    .select('id');
  if (claimErr) throw new WipRunError(`Could not start posting: ${claimErr.message}`, 500);
  if (!Array.isArray(claimed) || claimed.length === 0) {
    throw new WipRunError('Someone else is approving or has just changed this proposal. Refresh to see where it stands.', 409, 'NOT_PROPOSED');
  }

  /** Move OUR claim (POSTING only) to another status; never touches a run someone else moved. */
  const release = async (values: Record<string, unknown>): Promise<void> => {
    await writer.from('rev_rec_wip_runs')
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq('org_id', orgId).eq('id', run.id).eq('status', 'POSTING');
  };
  /** Give the claim back (nothing was posted) so the proposal can be approved again. */
  const refuse = async (message: string, status: number, code: string): Promise<never> => {
    await release({ status: 'PROPOSED' });
    throw new WipRunError(message, status, code);
  };

  try {
    const schedule = await loadWipSchedule(db, orgId, { locationId: run.location_id, periodKey: run.period_key });
    if (schedule.setupIssues.length > 0) await refuse(schedule.setupIssues[0], 422, 'ACCOUNT_ROLE_UNRESOLVED');
    if (schedule.entries.issues.length > 0) {
      const i = schedule.entries.issues[0];
      await refuse(`${i.jobNumber ?? 'A job'}: ${i.reason}`, 422, 'JOB_NOT_POSTABLE');
    }

    const { data: snap } = await db.from('rev_rec_wip_runs').select('policy_snapshot').eq('id', run.id).maybeSingle();
    const proposedFp = ((snap as { policy_snapshot: { fingerprint?: string } } | null)?.policy_snapshot?.fingerprint) ?? '';
    if (postingFingerprint(schedule.lines) !== proposedFp) {
      // Retire our claimed run first (proposeWipRun only supersedes PROPOSED runs).
      await release({ status: 'SUPERSEDED' });
      const fresh = await proposeWipRun(db, orgId, {
        locationId: run.location_id, periodKey: run.period_key, requestedBy: args.approvedBy, source: run.source, schedule,
      });
      throw new WipRunError(
        'The numbers changed since this was proposed (new billing or cost). A fresh proposal is ready — review it and approve again.',
        409,
        fresh.run ? `STALE:${fresh.run.id}` : 'STALE',
      );
    }

    if (schedule.period.status === 'HARD_CLOSE') await refuse(`${run.period_key} is hard-closed — reopen it to post the WIP entry`, 409, 'PERIOD_CLOSED');
    if (schedule.period.status === 'MISSING') await refuse(`There is no fiscal period for ${run.period_key}`, 409, 'PERIOD_MISSING');
    const needsReversal = schedule.entries.adjustment.length > 0;
    if (needsReversal && (schedule.nextPeriod.status === 'MISSING' || schedule.nextPeriod.status === 'HARD_CLOSE')) {
      await refuse(`Open next month (${schedule.reversalDate.slice(0, 7)}) first — the WIP entry reverses on ${schedule.reversalDate}`, 409, 'NEXT_PERIOD_UNAVAILABLE');
    }

    const refs = wipSourceRefs(run.location_id, run.period_key, run.revision);
    const company = schedule.company?.shortCode ?? '';
    const entryNumbers: PostResult['entryNumbers'] = {};
    const patch: Record<string, unknown> = {};

    /** A posting step failed: FAILED, but only from OUR claim (POSTING). */
    const fail = async (message: string): Promise<never> => {
      await release({ ...patch, status: 'FAILED', error: message });
      throw new WipRunError(message, 422, 'POST_FAILED');
    };

    // 1) permanent billings reclass
    if (schedule.entries.reclass.length > 0) {
      const r = await postJournalEntry(db, {
        org_id: orgId, location_id: run.location_id, entry_date: schedule.asOf, entry_type: 'ADJUSTING',
        memo: `WIP billings reclass ${run.period_key} ${company}`.trim(), source_module: WIP_RECLASS_SOURCE_MODULE,
        source_id: run.id, source_ref: refs.reclass, created_by: null, lines: schedule.entries.reclass,
      });
      if (!r.success || !r.entry_id) await fail(r.error ?? 'Posting the billings reclass failed');
      patch.reclass_entry_id = r.entry_id;
      entryNumbers.reclass = r.entry_number;
    }

    // 2) the WIP adjustment, 3) its reversal on the 1st of next month
    let reversalPending = false;
    if (needsReversal) {
      const a = await postJournalEntry(db, {
        org_id: orgId, location_id: run.location_id, entry_date: schedule.asOf, entry_type: 'ADJUSTING',
        memo: `WIP over/under billing ${run.period_key} ${company} (reverses ${schedule.reversalDate})`.trim(), source_module: WIP_SOURCE_MODULE,
        source_id: run.id, source_ref: refs.adjustment, created_by: null, lines: schedule.entries.adjustment,
      });
      if (!a.success || !a.entry_id) await fail(a.error ?? 'Posting the WIP adjustment failed');
      patch.wip_entry_id = a.entry_id;
      entryNumbers.adjustment = a.entry_number;

      const rv = await postJournalEntry(db, {
        org_id: orgId, location_id: run.location_id, entry_date: schedule.reversalDate, entry_type: 'REVERSING',
        memo: `Reverse WIP over/under billing ${run.period_key} ${company}`.trim(), source_module: WIP_SOURCE_MODULE,
        source_id: run.id, source_ref: refs.reversal, created_by: null, lines: schedule.entries.reversal,
      });
      if (rv.success && rv.entry_id) {
        patch.reversal_entry_id = rv.entry_id;
        entryNumbers.reversal = rv.entry_number;
      } else {
        reversalPending = true;
        patch.error = `Reversal not posted yet: ${rv.error ?? 'unknown'}`;
      }
    }

    const { data: updated, error } = await writer
      .from('rev_rec_wip_runs')
      .update({ ...patch, status: 'POSTED', approved_by: args.approvedBy, posted_at: new Date().toISOString(), reversal_pending: reversalPending, updated_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .eq('id', run.id)
      .eq('status', 'POSTING')
      .select(RUN_SELECT)
      .single();
    if (error || !updated) throw new WipRunError(`Posted, but the run record did not update: ${error?.message ?? 'unknown'}`, 500);
    return { run: updated as unknown as WipRunRow, entryNumbers, reversalPending };

  } catch (e) {
    // Anything unexpected (a thrown posting call, a network error) must not strand the claim:
    // move it to FAILED. release() only touches a run still in POSTING, so a refusal / failure
    // that already moved it is left alone.
    await release({ status: 'FAILED', error: e instanceof Error ? e.message.slice(0, 500) : 'Posting failed' }).catch(() => undefined);
    throw e;
  }
}

/** Post a reversal that failed at approval (e.g. next month was not open yet). */
export async function retryWipReversal(db: DB, orgId: string, args: { runId: string }): Promise<WipRunRow> {
  const run = await loadRun(db, orgId, args.runId);
  if (run.status !== 'POSTED' || !run.reversal_pending || !run.wip_entry_id) throw new WipRunError('No reversal is pending for this run', 409, 'NO_PENDING_REVERSAL');
  const { data: lines } = await db
    .from('gl_entry_lines')
    .select('account_id, debit_cents, credit_cents, location_id, job_id, memo')
    .eq('org_id', orgId)
    .eq('gl_entry_id', run.wip_entry_id);
  const flipped: JournalEntryLineInput[] = ((lines ?? []) as Array<{ account_id: string; debit_cents: number; credit_cents: number; location_id: string; job_id: string | null; memo: string | null }>).map((l) => ({
    account_id: l.account_id,
    debit_cents: num(l.credit_cents),
    credit_cents: num(l.debit_cents),
    location_id: l.location_id,
    job_id: l.job_id ?? undefined,
    memo: `Reverse: ${l.memo ?? 'WIP adjustment'}`,
  }));
  const refs = wipSourceRefs(run.location_id, run.period_key, run.revision);
  const rv = await postJournalEntry(db, {
    org_id: orgId, location_id: run.location_id, entry_date: nextPeriodStart(run.period_key), entry_type: 'REVERSING',
    memo: `Reverse WIP over/under billing ${run.period_key}`, source_module: WIP_SOURCE_MODULE,
    source_id: run.id, source_ref: refs.reversal, created_by: null, lines: flipped,
  });
  if (!rv.success || !rv.entry_id) throw new WipRunError(rv.error ?? 'Posting the reversal failed', 422, 'POST_FAILED');
  const writer = await scopedWriter(db, orgId, [run.location_id]);
  const { data: updated, error } = await writer
    .from('rev_rec_wip_runs')
    .update({ reversal_entry_id: rv.entry_id, reversal_pending: false, error: null })
    .eq('org_id', orgId)
    .eq('id', run.id)
    .select(RUN_SELECT)
    .single();
  if (error || !updated) throw new WipRunError(`Reversal posted, but the run record did not update: ${error?.message ?? 'unknown'}`, 500);
  return updated as unknown as WipRunRow;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dismiss
// ─────────────────────────────────────────────────────────────────────────────

export const MIN_DISMISS_REASON = 4;

export async function dismissWipRun(
  db: DB,
  orgId: string,
  args: { runId: string; reason: string; dismissedBy: string | null },
): Promise<WipRunRow> {
  const reason = args.reason.trim();
  if (reason.length < MIN_DISMISS_REASON) throw new WipRunError('Say why you are not booking this month’s WIP entry', 422, 'REASON_REQUIRED');
  const run = await loadRun(db, orgId, args.runId);
  if (run.status !== 'PROPOSED') throw new WipRunError(`This proposal is ${run.status.toLowerCase()} — only a proposal can be dismissed`, 409, 'NOT_PROPOSED');
  const writer = await scopedWriter(db, orgId, [run.location_id]);
  const { data, error } = await writer
    .from('rev_rec_wip_runs')
    .update({ status: 'DISMISSED', dismiss_reason: reason, dismissed_by: args.dismissedBy, dismissed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', run.id)
    .eq('status', 'PROPOSED') // never dismiss a run an approver has already claimed
    .select(RUN_SELECT);
  if (error) throw new WipRunError(`Could not dismiss: ${error.message}`, 500);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new WipRunError('This proposal is being posted or has just changed. Refresh to see where it stands.', 409, 'NOT_PROPOSED');
  return row as unknown as WipRunRow;
}

/** The job detail saved with a run (drill-down for a past proposal). */
export async function loadRunLines(db: DB, orgId: string, runId: string) {
  const { data } = await db
    .from('rev_rec_wip_run_lines')
    .select('job_id, job_number, job_name, method, contract_cents, eac_cents, cost_to_date_cents, pct_complete, earned_cents, billed_cents, under_cents, over_cents, loss_provision_cents, adj_revenue_cents, reclass_revenue_cents, fade_gain_cents, below_materiality')
    .eq('org_id', orgId)
    .eq('run_id', runId)
    .order('job_number');
  return data ?? [];
}
