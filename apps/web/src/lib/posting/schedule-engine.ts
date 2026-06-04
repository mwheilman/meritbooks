/**
 * Schedule engine — straight-line recognition over time.
 *
 * A posting_schedule has two explicit legs (debit + credit accounts) and runs
 * once per period for `months` periods. Each run posts DR debit / CR credit for
 * the period amount and writes a posting_schedule_runs row, so a re-run is
 * idempotent (the unique (schedule, year, month) skips already-posted periods).
 *
 *   PREPAID_AMORTIZATION  debit = expense,            credit = prepaid asset
 *   DEFERRED_REVENUE      debit = deferred-rev liab., credit = revenue
 *   STRAIGHT_LINE         debit/credit as supplied
 *
 * Direction is explicit (not type-inferred), so contra accounts can't be
 * mis-signed. Each period posts dated the last day of that period's month;
 * a period whose fiscal period is missing/closed is reported, not fatal.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from '../services/gl-posting';
import { PostingError } from './account-roles';

type DB = SupabaseClient;

export type ScheduleType = 'PREPAID_AMORTIZATION' | 'DEFERRED_REVENUE' | 'STRAIGHT_LINE';

export interface CreateScheduleInput {
  orgId: string;
  locationId: string;
  scheduleType: ScheduleType;
  debitAccountId: string;
  creditAccountId: string;
  totalCents: number;
  months: number;
  startDate: string; // YYYY-MM-DD
  departmentId?: string;
  sourceType?: string;
  sourceId?: string;
  memo?: string;
}

function lastDayOfMonth(year: number, month1to12: number): string {
  // month1to12 is 1-based; day 0 of next month = last day of this month.
  return new Date(Date.UTC(year, month1to12, 0)).toISOString().slice(0, 10);
}

function addMonths(start: string, n: number): { year: number; month: number } {
  const d = new Date(`${start}T00:00:00Z`);
  const base = d.getUTCFullYear() * 12 + d.getUTCMonth() + n; // months since year 0
  return { year: Math.floor(base / 12), month: (base % 12) + 1 };
}

/** Number of monthly periods from start through asOf, inclusive (>=0). */
function periodsElapsed(start: string, asOf: string): number {
  const s = new Date(`${start}T00:00:00Z`);
  const a = new Date(`${asOf}T00:00:00Z`);
  const months = (a.getUTCFullYear() - s.getUTCFullYear()) * 12 + (a.getUTCMonth() - s.getUTCMonth());
  return months + 1; // the start month itself is period 1
}

export async function createSchedule(db: DB, input: CreateScheduleInput): Promise<{ id: string }> {
  if (input.totalCents <= 0 || input.months <= 0) {
    throw new PostingError('Schedule needs a positive total and month count');
  }
  const perPeriod = Math.floor(input.totalCents / input.months);
  if (perPeriod <= 0) throw new PostingError('Per-period amount rounds to zero; reduce the term');

  const { data, error } = await db
    .from('posting_schedules')
    .insert({
      org_id: input.orgId,
      location_id: input.locationId,
      schedule_type: input.scheduleType,
      debit_account_id: input.debitAccountId,
      credit_account_id: input.creditAccountId,
      total_cents: input.totalCents,
      months: input.months,
      start_date: input.startDate,
      amount_per_period_cents: perPeriod,
      department_id: input.departmentId ?? null,
      source_type: input.sourceType ?? null,
      source_id: input.sourceId ?? null,
      memo: input.memo ?? null,
    })
    .select('id')
    .single();
  if (error || !data) throw new PostingError(`Failed to create schedule: ${error?.message}`);
  return { id: (data as { id: string }).id };
}

interface ScheduleRow {
  id: string;
  location_id: string;
  schedule_type: ScheduleType;
  debit_account_id: string;
  credit_account_id: string;
  total_cents: number;
  months: number;
  start_date: string;
  amount_per_period_cents: number;
  periods_posted: number;
  department_id: string | null;
  memo: string | null;
}

export interface ScheduleRunResult {
  asOf: string;
  schedules_processed: number;
  periods_posted: number;
  errors: { schedule_id: string; period: string; error: string }[];
}

/** Post every due, not-yet-posted period for all ACTIVE schedules, up to asOf. */
export async function runDueSchedules(db: DB, orgId: string, asOf: string): Promise<ScheduleRunResult> {
  const { data, error } = await db
    .from('posting_schedules')
    .select('id, location_id, schedule_type, debit_account_id, credit_account_id, total_cents, months, start_date, amount_per_period_cents, periods_posted, department_id, memo')
    .eq('org_id', orgId)
    .eq('status', 'ACTIVE');
  if (error) throw new PostingError(error.message);

  const schedules = (data ?? []) as ScheduleRow[];
  const result: ScheduleRunResult = { asOf, schedules_processed: 0, periods_posted: 0, errors: [] };

  for (const s of schedules) {
    result.schedules_processed++;
    const due = Math.min(periodsElapsed(s.start_date, asOf), s.months);
    const remainder = s.total_cents - s.amount_per_period_cents * (s.months - 1);

    for (let idx = s.periods_posted; idx < due; idx++) {
      const { year, month } = addMonths(s.start_date, idx);
      const amount = idx === s.months - 1 ? remainder : s.amount_per_period_cents;
      const entryDate = lastDayOfMonth(year, month);

      // Skip if already posted (defensive; the unique index also guards).
      const { data: existing } = await db
        .from('posting_schedule_runs')
        .select('id')
        .eq('schedule_id', s.id)
        .eq('period_year', year)
        .eq('period_month', month)
        .maybeSingle();
      if (existing) continue;

      const je = await postJournalEntry(db, {
        org_id: orgId,
        location_id: s.location_id,
        entry_date: entryDate,
        entry_type: 'ADJUSTING',
        memo: s.memo ?? `${s.schedule_type} ${year}-${String(month).padStart(2, '0')}`,
        source_module: 'SCHEDULE',
        source_id: s.id,
        created_by: null,
        lines: [
          { account_id: s.debit_account_id, debit_cents: amount, credit_cents: 0, location_id: s.location_id, department_id: s.department_id ?? undefined },
          { account_id: s.credit_account_id, debit_cents: 0, credit_cents: amount, location_id: s.location_id, department_id: s.department_id ?? undefined },
        ],
      });

      if (!je.success) {
        result.errors.push({ schedule_id: s.id, period: `${year}-${month}`, error: je.error ?? 'post failed' });
        break; // don't skip ahead past a failed period (e.g. closed period)
      }

      await db.from('posting_schedule_runs').insert({
        org_id: orgId,
        schedule_id: s.id,
        period_year: year,
        period_month: month,
        amount_cents: amount,
        gl_entry_id: je.entry_id,
      });
      const newPosted = idx + 1;
      await db
        .from('posting_schedules')
        .update({
          periods_posted: newPosted,
          status: newPosted >= s.months ? 'COMPLETED' : 'ACTIVE',
          updated_at: new Date().toISOString(),
        })
        .eq('id', s.id);
      result.periods_posted++;
    }
  }

  return result;
}
