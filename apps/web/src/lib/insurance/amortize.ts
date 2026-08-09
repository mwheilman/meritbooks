/**
 * Insurance premium amortization — persistence + posting.
 *
 * A paid-up-front insurance premium is an ASSET (prepaid insurance) that is consumed
 * straight-line over the coverage term. This engine mirrors the prepaid-expense rail
 * (`lib/prepaid/amortize.ts`) but on the dedicated insurance tables (migration 132)
 * so a schedule links to its policy and carries a concrete posting location even when
 * the policy is null-location / consolidated.
 *
 * Storage: an `insurance_amortization_schedules` row with explicit legs — DR
 * expense (INSURANCE_EXPENSE role) / CR prepaid insurance (PREPAID_INSURANCE role) —
 * plus the run ledger `insurance_amortization_runs`. The run ledger's UNIQUE
 * (schedule_id, period_year, period_month) is the double-post guarantor; we also
 * pre-check defensively.
 *
 * Posting: `runInsuranceAmortizations` recomputes the EVEN-SPLIT schedule from
 * (total, start, months) with the SAME pure `buildAmortizationSchedule` used for
 * prepaids, and posts every due, not-yet-run period as a balanced JE through
 * `postJournalEntry` (DR expense / CR prepaid insurance, dated month-end, entry_type
 * ADJUSTING, source_module 'INSURANCE', source_id = the schedule id). A single-
 * schedule run (the "record this period" action) passes `scheduleId`; a period whose
 * fiscal period is missing/closed is reported, not fatal, and the catch-up stops
 * there so nothing posts out of order. Deterministic — no AI in this path.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from '../services/gl-posting';
import { buildAmortizationSchedule, evenPerPeriodCents } from '../prepaid/schedule';

type DB = SupabaseClient;

export class InsuranceAmortizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsuranceAmortizationError';
  }
}

export interface CreateInsuranceScheduleInput {
  orgId: string;
  policyId: string;
  locationId: string;
  /** DR leg — the insurance expense account the premium amortizes into. */
  expenseAccountId: string;
  /** CR leg — the prepaid-insurance ASSET account. */
  prepaidAccountId: string;
  totalCents: number;
  months: number;
  startDate: string; // YYYY-MM-DD
  departmentId?: string | null;
  memo?: string | null;
  createdByUser?: string | null;
}

/** Create an insurance amortization schedule (validates via the pure schedule math). */
export async function createInsuranceSchedule(
  db: DB,
  input: CreateInsuranceScheduleInput,
): Promise<{ id: string }> {
  if (input.totalCents <= 0 || input.months <= 0) {
    throw new InsuranceAmortizationError('Amortization needs a positive premium and at least one period');
  }
  const perPeriod = evenPerPeriodCents(input.totalCents, input.months);
  if (perPeriod <= 0) throw new InsuranceAmortizationError('The per-period amount rounds to zero — shorten the term');
  // Validate the date/term shape up front (throws otherwise).
  buildAmortizationSchedule({ totalCents: input.totalCents, startDate: input.startDate, months: input.months });

  const { data, error } = await db
    .from('insurance_amortization_schedules')
    .insert({
      org_id: input.orgId,
      policy_id: input.policyId,
      location_id: input.locationId,
      expense_account_id: input.expenseAccountId,
      prepaid_account_id: input.prepaidAccountId,
      total_cents: input.totalCents,
      months: input.months,
      start_date: input.startDate,
      amount_per_period_cents: perPeriod,
      department_id: input.departmentId ?? null,
      memo: input.memo ?? null,
      created_by_user: input.createdByUser ?? null,
    })
    .select('id')
    .single();

  if (error || !data) {
    // A live-schedule uniqueness collision reads as "already amortizing".
    if (error && /uq_insurance_amort_policy_live|duplicate|unique/i.test(error.message)) {
      throw new InsuranceAmortizationError('This policy already has an active amortization schedule');
    }
    throw new InsuranceAmortizationError(`Failed to create amortization schedule: ${error?.message ?? 'unknown'}`);
  }
  return { id: (data as { id: string }).id };
}

interface ScheduleRow {
  id: string;
  policy_id: string;
  location_id: string;
  expense_account_id: string;
  prepaid_account_id: string;
  total_cents: number;
  months: number;
  start_date: string;
  amount_per_period_cents: number;
  periods_posted: number;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  department_id: string | null;
  memo: string | null;
}

export interface InsuranceScheduleSummary {
  id: string;
  policy_id: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  total_cents: number;
  months: number;
  start_date: string;
  amount_per_period_cents: number;
  periods_posted: number;
  remaining_cents: number;
  posted_cents: number;
  next_period: string | null;
  next_amount_cents: number | null;
  next_post_date: string | null;
  expense_account_id: string;
  prepaid_account_id: string;
  expense_account_name: string | null;
  prepaid_account_name: string | null;
  policy_carrier: string | null;
  policy_number: string | null;
  coverage_type: string | null;
  memo: string | null;
}

/**
 * List every insurance amortization schedule with remaining balance + next period.
 * RLS-scoped; enriches with account + policy names in single lookups.
 */
export async function listInsuranceSchedules(db: DB): Promise<InsuranceScheduleSummary[]> {
  const { data, error } = await db
    .from('insurance_amortization_schedules')
    .select(
      'id, policy_id, location_id, expense_account_id, prepaid_account_id, total_cents, months, start_date, ' +
        'amount_per_period_cents, periods_posted, status, department_id, memo, created_at',
    )
    .order('created_at', { ascending: false });
  if (error) throw new InsuranceAmortizationError(error.message);

  const rows = (data ?? []) as unknown as (ScheduleRow & { created_at: string })[];
  if (rows.length === 0) return [];

  // Account names.
  const acctIds = Array.from(new Set(rows.flatMap((r) => [r.expense_account_id, r.prepaid_account_id])));
  const nameById = new Map<string, string>();
  try {
    const { data: accts } = await db.from('accounts').select('id, name').in('id', acctIds);
    for (const a of (accts ?? []) as { id: string; name: string }[]) nameById.set(a.id, a.name);
  } catch {
    /* names are cosmetic */
  }

  // Policy metadata.
  const policyIds = Array.from(new Set(rows.map((r) => r.policy_id)));
  const policyById = new Map<string, { carrier: string | null; policy_number: string | null; coverage_type: string | null }>();
  try {
    const { data: policies } = await db
      .from('insurance_policies')
      .select('id, carrier, policy_number, coverage_type')
      .in('id', policyIds);
    for (const p of (policies ?? []) as { id: string; carrier: string | null; policy_number: string | null; coverage_type: string | null }[]) {
      policyById.set(p.id, { carrier: p.carrier, policy_number: p.policy_number, coverage_type: p.coverage_type });
    }
  } catch {
    /* policy metadata is cosmetic */
  }

  // Posted-to-date from the run ledger.
  const postedById = new Map<string, number>();
  try {
    const { data: runs } = await db
      .from('insurance_amortization_runs')
      .select('schedule_id, amount_cents')
      .in('schedule_id', rows.map((r) => r.id));
    for (const run of (runs ?? []) as { schedule_id: string; amount_cents: number }[]) {
      postedById.set(run.schedule_id, (postedById.get(run.schedule_id) ?? 0) + Number(run.amount_cents || 0));
    }
  } catch {
    /* fall back to periods_posted * per-period below */
  }

  return rows.map((r) => {
    const total = Number(r.total_cents);
    const posted = postedById.get(r.id) ?? Number(r.amount_per_period_cents) * r.periods_posted;
    const remaining = Math.max(0, total - posted);
    const policy = policyById.get(r.policy_id);

    let nextPeriod: string | null = null;
    let nextAmount: number | null = null;
    let nextPostDate: string | null = null;
    if (r.status === 'ACTIVE' && r.periods_posted < r.months) {
      try {
        const lines = buildAmortizationSchedule({ totalCents: total, startDate: r.start_date, months: r.months });
        const next = lines[r.periods_posted];
        if (next) {
          nextPeriod = next.period;
          nextAmount = next.amountCents;
          nextPostDate = next.postDate;
        }
      } catch {
        /* leave next unset */
      }
    }

    return {
      id: r.id,
      policy_id: r.policy_id,
      status: r.status,
      total_cents: total,
      months: r.months,
      start_date: r.start_date,
      amount_per_period_cents: Number(r.amount_per_period_cents),
      periods_posted: r.periods_posted,
      remaining_cents: remaining,
      posted_cents: posted,
      next_period: nextPeriod,
      next_amount_cents: nextAmount,
      next_post_date: nextPostDate,
      expense_account_id: r.expense_account_id,
      prepaid_account_id: r.prepaid_account_id,
      expense_account_name: nameById.get(r.expense_account_id) ?? null,
      prepaid_account_name: nameById.get(r.prepaid_account_id) ?? null,
      policy_carrier: policy?.carrier ?? null,
      policy_number: policy?.policy_number ?? null,
      coverage_type: policy?.coverage_type ?? null,
      memo: r.memo,
    };
  });
}

/** Cancel a schedule — future amortization stops; posted periods are untouched. */
export async function cancelInsuranceSchedule(db: DB, scheduleId: string): Promise<void> {
  const { error } = await db
    .from('insurance_amortization_schedules')
    .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
    .eq('id', scheduleId)
    .eq('status', 'ACTIVE');
  if (error) throw new InsuranceAmortizationError(error.message);
}

export interface RunResult {
  asOf: string;
  schedules_processed: number;
  periods_posted: number;
  amount_posted_cents: number;
  completed: number;
  errors: { schedule_id: string; period: string; error: string }[];
}

function asOfIndex(asOf: string): number {
  const d = new Date(`${asOf}T00:00:00Z`);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/**
 * Post every due, not-yet-run insurance amortization period up to `asOf`. Pass
 * `scheduleId` to run a single schedule (the "record this period" action). A period
 * is due once its calendar month has begun on/before `asOf`. Never throws — a failed
 * period (e.g. a closed fiscal period) is captured and stops that schedule's catch-up
 * without derailing the others.
 */
export async function runInsuranceAmortizations(
  db: DB,
  orgId: string,
  opts: { asOf: string; scheduleId?: string },
): Promise<RunResult> {
  const { asOf, scheduleId } = opts;
  const result: RunResult = {
    asOf,
    schedules_processed: 0,
    periods_posted: 0,
    amount_posted_cents: 0,
    completed: 0,
    errors: [],
  };

  let query = db
    .from('insurance_amortization_schedules')
    .select(
      'id, policy_id, location_id, expense_account_id, prepaid_account_id, total_cents, months, start_date, ' +
        'amount_per_period_cents, periods_posted, status, department_id, memo',
    )
    .eq('status', 'ACTIVE');
  if (scheduleId) query = query.eq('id', scheduleId);

  const { data, error } = await query;
  if (error) throw new InsuranceAmortizationError(error.message);

  const schedules = (data ?? []) as unknown as ScheduleRow[];
  const cutoff = asOfIndex(asOf);

  for (const s of schedules) {
    result.schedules_processed++;

    let lines;
    try {
      lines = buildAmortizationSchedule({ totalCents: Number(s.total_cents), startDate: s.start_date, months: s.months });
    } catch (e) {
      result.errors.push({ schedule_id: s.id, period: '-', error: e instanceof Error ? e.message : 'bad schedule' });
      continue;
    }

    let postedThisSchedule = s.periods_posted;
    for (let idx = s.periods_posted; idx < s.months; idx++) {
      const line = lines[idx];
      if (!line) break;
      // Due only once the period's month has started on/before asOf.
      if (line.year * 12 + (line.month - 1) > cutoff) break;

      // Defensive double-post pre-check (the unique index is the real guard).
      const { data: existing } = await db
        .from('insurance_amortization_runs')
        .select('id')
        .eq('schedule_id', s.id)
        .eq('period_year', line.year)
        .eq('period_month', line.month)
        .maybeSingle();
      if (existing) {
        postedThisSchedule = Math.max(postedThisSchedule, idx + 1);
        continue;
      }

      const je = await postJournalEntry(db, {
        org_id: orgId,
        location_id: s.location_id,
        entry_date: line.postDate,
        entry_type: 'ADJUSTING',
        memo: s.memo ?? `Insurance amortization ${line.period}`,
        source_module: 'INSURANCE',
        source_id: s.id,
        created_by: null,
        lines: [
          {
            account_id: s.expense_account_id,
            debit_cents: line.amountCents,
            credit_cents: 0,
            location_id: s.location_id,
            department_id: s.department_id ?? undefined,
          },
          {
            account_id: s.prepaid_account_id,
            debit_cents: 0,
            credit_cents: line.amountCents,
            location_id: s.location_id,
            department_id: s.department_id ?? undefined,
          },
        ],
      });

      if (!je.success) {
        result.errors.push({ schedule_id: s.id, period: line.period, error: je.error ?? 'post failed' });
        break; // stop catch-up at the first failure (e.g. a closed period)
      }

      const { error: runErr } = await db.from('insurance_amortization_runs').insert({
        org_id: orgId,
        schedule_id: s.id,
        period_year: line.year,
        period_month: line.month,
        amount_cents: line.amountCents,
        gl_entry_id: je.entry_id,
      });
      // A unique-violation here means a concurrent run beat us — treat as posted.
      if (runErr && !/duplicate|unique/i.test(runErr.message)) {
        result.errors.push({ schedule_id: s.id, period: line.period, error: runErr.message });
        break;
      }

      postedThisSchedule = idx + 1;
      result.periods_posted++;
      result.amount_posted_cents += line.amountCents;
    }

    if (postedThisSchedule !== s.periods_posted) {
      const completed = postedThisSchedule >= s.months;
      await db
        .from('insurance_amortization_schedules')
        .update({
          periods_posted: postedThisSchedule,
          status: completed ? 'COMPLETED' : 'ACTIVE',
          updated_at: new Date().toISOString(),
        })
        .eq('id', s.id);
      if (completed) result.completed++;
    }
  }

  return result;
}
