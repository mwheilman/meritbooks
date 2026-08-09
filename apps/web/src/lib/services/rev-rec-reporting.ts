/**
 * Revenue-recognition REPORTING (read-only surface on top of the rev-rec engine).
 *
 * This module NEVER posts and NEVER mutates recognition state — it reads the
 * artifacts the engine already produces (`lib/services/rev-rec.ts`):
 *   - GL account 2410 (Deferred Revenue / billings-in-excess) lines, for the
 *     deferred-revenue ROLLFORWARD (beginning → additions → recognized → ending).
 *   - `revenue_recognition_runs` (one row per job per posting), for the per-job
 *     recognition WATERFALL and the by-METHOD summary of revenue recognized in a
 *     period.
 *
 * All queries run through the caller's RLS-scoped client (org isolation) and take
 * an optional `locationId` sub-filter so the surface is company-scoped. Every
 * financial figure follows the reporting convention used by the statement views:
 * only `status='POSTED'` GL entries count.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type DB = SupabaseClient;

const DEFERRED_ACCT = '2410'; // Deferred Revenue (billings in excess)

/** Human labels for the nine recognition methods (white-label, no tenant names). */
export const METHOD_LABEL: Record<string, string> = {
  PCT_COSTS_INCURRED: 'Percent of costs (cost-to-cost)',
  PCT_COMPLETE: 'Percent complete (physical)',
  COMPLETED_CONTRACT: 'Completed contract',
  POINT_OF_SALE: 'Point of sale',
  MILESTONE: 'Milestone / point-in-time',
  AS_BILLED: 'Billing-based (as billed)',
  RATABLY: 'Straight-line / ratable',
  SUBSCRIPTION: 'Subscription (ratable)',
  CASH: 'Cash basis',
};

export interface RevRecPeriod {
  /** YYYY-MM */
  month: string;
  /** YYYY-MM-DD (first day) */
  start: string;
  /** YYYY-MM-DD (last day) */
  end: string;
  /** e.g. "August 2026" */
  label: string;
}

/** Resolve the reporting period from a `YYYY-MM` string (defaults to current month). */
export function resolvePeriod(month?: string | null): RevRecPeriod {
  let y: number;
  let m: number; // 1..12
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    y = Number(month.slice(0, 4));
    m = Number(month.slice(5, 7));
  } else {
    const now = new Date();
    y = now.getUTCFullYear();
    m = now.getUTCMonth() + 1;
  }
  const startD = new Date(Date.UTC(y, m - 1, 1));
  const endD = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    month: `${y}-${pad(m)}`,
    start: startD.toISOString().slice(0, 10),
    end: endD.toISOString().slice(0, 10),
    label: startD.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

// ---------------------------------------------------------------------------
// Company (location) name map
// ---------------------------------------------------------------------------

interface CompanyMeta {
  id: string;
  name: string;
  shortCode: string;
}

async function loadCompanyMeta(db: DB, ids: string[]): Promise<Map<string, CompanyMeta>> {
  if (ids.length === 0) return new Map();
  const { data } = await db
    .schema('core')
    .from('locations')
    .select('id, name, short_code')
    .in('id', [...new Set(ids)]);
  return new Map(
    ((data ?? []) as Array<{ id: string; name: string; short_code: string | null }>).map((l) => [
      l.id,
      { id: l.id, name: l.name, shortCode: l.short_code ?? '' },
    ]),
  );
}

// ---------------------------------------------------------------------------
// 1. Deferred-revenue rollforward (ties to account 2410)
// ---------------------------------------------------------------------------

export interface RollforwardRow {
  locationId: string;
  name: string;
  shortCode: string;
  beginningCents: number;
  additionsCents: number; // new billings deferred this period (credits to 2410)
  recognizedCents: number; // relieved into revenue this period (debits to 2410)
  endingCents: number;
}

export interface DeferredRollforward {
  account: { number: string; name: string } | null;
  hasAccount: boolean;
  total: {
    beginningCents: number;
    additionsCents: number;
    recognizedCents: number;
    endingCents: number;
  };
  byCompany: RollforwardRow[];
}

interface DeferredLine {
  debit_cents: number | null;
  credit_cents: number | null;
  location_id: string;
  gl_entries: { entry_date: string; status: string } | { entry_date: string; status: string }[] | null;
}

function entryDateOf(l: DeferredLine): string | null {
  const e = l.gl_entries;
  if (!e) return null;
  const row = Array.isArray(e) ? e[0] : e;
  return row?.entry_date ?? null;
}

export async function deferredRollforward(
  db: DB,
  orgId: string,
  args: { locationId?: string | null; period: RevRecPeriod },
): Promise<DeferredRollforward> {
  // Resolve the 2410 account for this org.
  const { data: acct } = await db
    .from('accounts')
    .select('id, account_number, name')
    .eq('org_id', orgId)
    .eq('account_number', DEFERRED_ACCT)
    .limit(1)
    .maybeSingle();

  const empty: DeferredRollforward = {
    account: null,
    hasAccount: false,
    total: { beginningCents: 0, additionsCents: 0, recognizedCents: 0, endingCents: 0 },
    byCompany: [],
  };
  if (!acct) return empty;

  const account = acct as { id: string; account_number: string; name: string };

  // All POSTED 2410 lines up to and including the period end. We bucket in JS by
  // whether they fall before the period (beginning balance) or inside it.
  let q = db
    .from('gl_entry_lines')
    .select('debit_cents, credit_cents, location_id, gl_entries!inner(entry_date, status)')
    .eq('org_id', orgId)
    .eq('account_id', account.id)
    .eq('gl_entries.status', 'POSTED')
    .lte('gl_entries.entry_date', args.period.end);
  if (args.locationId) q = q.eq('location_id', args.locationId);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const lines = (data ?? []) as unknown as DeferredLine[];

  const byLoc = new Map<string, RollforwardRow>();
  const ensure = (locId: string): RollforwardRow => {
    let row = byLoc.get(locId);
    if (!row) {
      row = { locationId: locId, name: '', shortCode: '', beginningCents: 0, additionsCents: 0, recognizedCents: 0, endingCents: 0 };
      byLoc.set(locId, row);
    }
    return row;
  };

  for (const l of lines) {
    const d = entryDateOf(l);
    if (!d) continue;
    const debit = Number(l.debit_cents ?? 0);
    const credit = Number(l.credit_cents ?? 0);
    const row = ensure(l.location_id);
    if (d < args.period.start) {
      // Deferred revenue is a liability (credit-normal): balance = credits − debits.
      row.beginningCents += credit - debit;
    } else {
      row.additionsCents += credit; // new deferrals (billings in excess)
      row.recognizedCents += debit; // relieved into revenue
    }
  }

  const meta = await loadCompanyMeta(db, [...byLoc.keys()]);
  const rows: RollforwardRow[] = [...byLoc.values()].map((r) => {
    const m = meta.get(r.locationId);
    return {
      ...r,
      name: m?.name ?? 'Unknown company',
      shortCode: m?.shortCode ?? '',
      endingCents: r.beginningCents + r.additionsCents - r.recognizedCents,
    };
  });
  rows.sort((a, b) => b.endingCents - a.endingCents || a.name.localeCompare(b.name));

  const total = rows.reduce(
    (t, r) => ({
      beginningCents: t.beginningCents + r.beginningCents,
      additionsCents: t.additionsCents + r.additionsCents,
      recognizedCents: t.recognizedCents + r.recognizedCents,
      endingCents: t.endingCents + r.endingCents,
    }),
    { beginningCents: 0, additionsCents: 0, recognizedCents: 0, endingCents: 0 },
  );

  return {
    account: { number: account.account_number, name: account.name },
    hasAccount: true,
    total,
    byCompany: rows,
  };
}

// ---------------------------------------------------------------------------
// 2. Per-job recognition waterfall + 3. by-method summary (both from runs)
// ---------------------------------------------------------------------------

interface RunRow {
  job_id: string;
  location_id: string;
  as_of_date: string;
  method: string;
  contract_value_cents: number | null;
  earned_to_date_cents: number | null;
  recognized_delta_cents: number | null;
  pct_recognized: number | null;
}

export interface WaterfallJob {
  jobId: string;
  jobNumber: string | null;
  jobName: string | null;
  locationId: string;
  companyName: string;
  method: string;
  methodLabel: string;
  contractCents: number;
  recognizedToDateCents: number;
  remainingCents: number;
  pctRecognized: number; // 0..1
  byPeriod: Record<string, number>; // 'YYYY-MM' -> recognized delta cents
}

export interface RecognitionWaterfall {
  periods: string[]; // chronological YYYY-MM column headers (capped)
  jobs: WaterfallJob[];
}

export interface MethodSummaryRow {
  method: string;
  methodLabel: string;
  recognizedCents: number;
  jobCount: number;
  pct: number; // 0..1 share of period total
}

export interface MethodSummary {
  totalRecognizedCents: number;
  rows: MethodSummaryRow[];
}

const MAX_WATERFALL_COLUMNS = 12;

/**
 * Load all recognition runs up to the period end (for the cumulative waterfall)
 * once, then derive both the per-job waterfall and the in-period method summary.
 */
export async function recognitionWaterfallAndMethods(
  db: DB,
  orgId: string,
  args: { locationId?: string | null; period: RevRecPeriod },
): Promise<{ waterfall: RecognitionWaterfall; methodSummary: MethodSummary }> {
  let q = db
    .from('revenue_recognition_runs')
    .select('job_id, location_id, as_of_date, method, contract_value_cents, earned_to_date_cents, recognized_delta_cents, pct_recognized')
    .eq('org_id', orgId)
    .lte('as_of_date', args.period.end)
    .order('as_of_date', { ascending: true });
  if (args.locationId) q = q.eq('location_id', args.locationId);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const runs = (data ?? []) as RunRow[];

  // ---- Per-job aggregation (cumulative through period end) ----
  interface JobAgg {
    jobId: string;
    locationId: string;
    method: string;
    contractCents: number;
    recognizedToDateCents: number;
    pctRecognized: number;
    byPeriod: Record<string, number>;
    lastDate: string;
  }
  const jobs = new Map<string, JobAgg>();
  const allMonths = new Set<string>();

  for (const r of runs) {
    const month = r.as_of_date.slice(0, 7);
    allMonths.add(month);
    const delta = Number(r.recognized_delta_cents ?? 0);
    let j = jobs.get(r.job_id);
    if (!j) {
      j = {
        jobId: r.job_id,
        locationId: r.location_id,
        method: r.method,
        contractCents: Number(r.contract_value_cents ?? 0),
        recognizedToDateCents: 0,
        pctRecognized: 0,
        byPeriod: {},
        lastDate: r.as_of_date,
      };
      jobs.set(r.job_id, j);
    }
    j.byPeriod[month] = (j.byPeriod[month] ?? 0) + delta;
    // Cumulative recognized-to-date = latest run's earned_to_date (telescopes deltas),
    // falling back to summing deltas when earned isn't recorded.
    if (r.as_of_date >= j.lastDate) {
      j.lastDate = r.as_of_date;
      j.method = r.method;
      j.contractCents = Number(r.contract_value_cents ?? j.contractCents);
      j.pctRecognized = Number(r.pct_recognized ?? j.pctRecognized);
      j.recognizedToDateCents = Number(r.earned_to_date_cents ?? j.recognizedToDateCents);
    }
  }

  // Column headers: chronological, capped to the most recent N.
  const sortedMonths = [...allMonths].sort();
  const periods = sortedMonths.slice(-MAX_WATERFALL_COLUMNS);

  // Enrich with job number/name + contract from core.jobs (authoritative contract).
  const jobIds = [...jobs.keys()];
  const jobMeta = new Map<string, { job_number: string | null; name: string | null; contract_amount_cents: number | null }>();
  if (jobIds.length > 0) {
    const { data: meta } = await db
      .schema('core')
      .from('jobs')
      .select('id, job_number, name, contract_amount_cents')
      .in('id', jobIds);
    for (const m of (meta ?? []) as Array<{ id: string; job_number: string | null; name: string | null; contract_amount_cents: number | null }>) {
      jobMeta.set(m.id, { job_number: m.job_number, name: m.name, contract_amount_cents: m.contract_amount_cents });
    }
  }

  const companyMeta = await loadCompanyMeta(db, jobIds.map((id) => jobs.get(id)!.locationId));

  const waterfallJobs: WaterfallJob[] = [...jobs.values()].map((j) => {
    const jm = jobMeta.get(j.jobId);
    const contract = jm?.contract_amount_cents != null && jm.contract_amount_cents > 0
      ? Number(jm.contract_amount_cents)
      : j.contractCents;
    const recognized = j.recognizedToDateCents;
    return {
      jobId: j.jobId,
      jobNumber: jm?.job_number ?? null,
      jobName: jm?.name ?? null,
      locationId: j.locationId,
      companyName: companyMeta.get(j.locationId)?.name ?? '',
      method: j.method,
      methodLabel: METHOD_LABEL[j.method] ?? j.method,
      contractCents: contract,
      recognizedToDateCents: recognized,
      remainingCents: Math.max(0, contract - recognized),
      pctRecognized: contract > 0 ? Math.min(1, recognized / contract) : j.pctRecognized,
      byPeriod: j.byPeriod,
    };
  });
  // Most active / largest remaining first.
  waterfallJobs.sort((a, b) => b.recognizedToDateCents - a.recognizedToDateCents || (a.jobName ?? '').localeCompare(b.jobName ?? ''));

  // ---- Method summary (in-period only) ----
  const methodAgg = new Map<string, { recognizedCents: number; jobs: Set<string> }>();
  let totalRecognizedCents = 0;
  for (const r of runs) {
    if (r.as_of_date < args.period.start || r.as_of_date > args.period.end) continue;
    const delta = Number(r.recognized_delta_cents ?? 0);
    let a = methodAgg.get(r.method);
    if (!a) {
      a = { recognizedCents: 0, jobs: new Set() };
      methodAgg.set(r.method, a);
    }
    a.recognizedCents += delta;
    a.jobs.add(r.job_id);
    totalRecognizedCents += delta;
  }

  const methodRows: MethodSummaryRow[] = [...methodAgg.entries()]
    .map(([method, a]) => ({
      method,
      methodLabel: METHOD_LABEL[method] ?? method,
      recognizedCents: a.recognizedCents,
      jobCount: a.jobs.size,
      pct: totalRecognizedCents !== 0 ? a.recognizedCents / totalRecognizedCents : 0,
    }))
    .sort((a, b) => b.recognizedCents - a.recognizedCents);

  return {
    waterfall: { periods, jobs: waterfallJobs },
    methodSummary: { totalRecognizedCents, rows: methodRows },
  };
}

// ---------------------------------------------------------------------------
// Combined report loader
// ---------------------------------------------------------------------------

export interface RevRecReport {
  period: RevRecPeriod;
  rollforward: DeferredRollforward;
  waterfall: RecognitionWaterfall;
  methodSummary: MethodSummary;
}

export async function loadRevRecReport(
  db: DB,
  orgId: string,
  args: { locationId?: string | null; month?: string | null },
): Promise<RevRecReport> {
  const period = resolvePeriod(args.month);
  const [rollforward, wm] = await Promise.all([
    deferredRollforward(db, orgId, { locationId: args.locationId, period }),
    recognitionWaterfallAndMethods(db, orgId, { locationId: args.locationId, period }),
  ]);
  return {
    period,
    rollforward,
    waterfall: wm.waterfall,
    methodSummary: wm.methodSummary,
  };
}
