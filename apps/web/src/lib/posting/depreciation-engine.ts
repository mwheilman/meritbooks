/**
 * Depreciation engine.
 *
 * Reads the schedule straight off fixed_assets (acquisition cost, salvage, useful
 * life, method, and the three GL accounts) and posts monthly depreciation:
 *   DR depreciation_expense_account / CR accumulated_depreciation_account.
 *
 * Idempotent: a depreciation_runs row per (asset, period) is the guard, so a
 * re-run never double-posts. Depreciation stops when accumulated reaches the
 * depreciable base (cost − salvage); the final period takes the remainder so it
 * lands exactly on the base.
 *
 * The per-period amounts come from the PURE `depreciation-methods` module, so the
 * time-based methods (STRAIGHT_LINE and DOUBLE_DECLINING → 200% declining-balance
 * with SL switchover) are computed the same way here and in the UI preview, and
 * are independently unit-tested. Enum values that can't yet be driven from the
 * current schema (MACRS_* — tax track; SYD / 150%-DB / units-of-production — need
 * new enum values) are reported as unsupported rather than approximated.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from '../services/gl-posting';
import { PostingError } from './account-roles';
import { buildDepreciationSchedule, mapBookMethod } from './depreciation-methods';

type DB = SupabaseClient;

interface AssetRow {
  id: string;
  location_id: string;
  name: string;
  acquisition_date: string;
  acquisition_cost_cents: number;
  salvage_value_cents: number;
  useful_life_months: number;
  depreciation_method: string;
  depreciation_expense_account_id: string;
  accumulated_depreciation_account_id: string;
  accumulated_depreciation_cents: number;
  last_depreciation_date: string | null;
  status: string;
}

function lastDayOfMonth(year: number, month1to12: number): string {
  return new Date(Date.UTC(year, month1to12, 0)).toISOString().slice(0, 10);
}

function addMonths(start: string, n: number): { year: number; month: number } {
  const d = new Date(`${start}T00:00:00Z`);
  const base = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  return { year: Math.floor(base / 12), month: (base % 12) + 1 };
}

function monthsElapsed(start: string, asOf: string): number {
  const s = new Date(`${start}T00:00:00Z`);
  const a = new Date(`${asOf}T00:00:00Z`);
  return (a.getUTCFullYear() - s.getUTCFullYear()) * 12 + (a.getUTCMonth() - s.getUTCMonth()) + 1;
}

export interface DepreciationRunResult {
  asOf: string;
  assets_processed: number;
  periods_posted: number;
  skipped: { asset_id: string; reason: string }[];
  errors: { asset_id: string; period: string; error: string }[];
}

/** Post all due monthly depreciation for ACTIVE assets up to asOf. */
export async function runDepreciation(db: DB, orgId: string, asOf: string): Promise<DepreciationRunResult> {
  const { data, error } = await db
    .from('fixed_assets')
    .select('id, location_id, name, acquisition_date, acquisition_cost_cents, salvage_value_cents, useful_life_months, depreciation_method, depreciation_expense_account_id, accumulated_depreciation_account_id, accumulated_depreciation_cents, last_depreciation_date, status')
    .eq('org_id', orgId)
    .eq('status', 'ACTIVE');
  if (error) throw new PostingError(error.message);

  const assets = (data ?? []) as AssetRow[];
  const result: DepreciationRunResult = { asOf, assets_processed: 0, periods_posted: 0, skipped: [], errors: [] };

  for (const a of assets) {
    result.assets_processed++;

    const mapped = mapBookMethod(a.depreciation_method);
    if (!mapped) {
      result.skipped.push({
        asset_id: a.id,
        reason: `method ${a.depreciation_method} not book-postable here (MACRS_* → tax engine; SYD / 150%-DB / units-of-production need a new enum value)`,
      });
      continue;
    }

    const base = a.acquisition_cost_cents - a.salvage_value_cents;
    if (base <= 0 || a.useful_life_months <= 0) {
      result.skipped.push({ asset_id: a.id, reason: 'no depreciable base or zero useful life' });
      continue;
    }

    // Build the full pure schedule once; each period posts schedule[idx].
    let schedule: number[];
    try {
      schedule = buildDepreciationSchedule({
        costCents: a.acquisition_cost_cents,
        salvageCents: a.salvage_value_cents,
        usefulLifeMonths: a.useful_life_months,
        method: mapped.method,
        decliningFactor: mapped.decliningFactor,
      });
    } catch (e) {
      result.skipped.push({ asset_id: a.id, reason: e instanceof Error ? e.message : 'schedule build failed' });
      continue;
    }

    // Periods already posted = months between acquisition and last_depreciation_date.
    const start = a.acquisition_date;
    const alreadyPosted = a.last_depreciation_date ? monthsElapsed(start, a.last_depreciation_date) : 0;
    const due = Math.min(monthsElapsed(start, asOf), a.useful_life_months);

    let accumulated = a.accumulated_depreciation_cents;

    for (let idx = alreadyPosted; idx < due; idx++) {
      const { year, month } = addMonths(start, idx);

      const { data: existing } = await db
        .from('depreciation_runs')
        .select('id')
        .eq('fixed_asset_id', a.id)
        .eq('period_year', year)
        .eq('period_month', month)
        .maybeSingle();
      if (existing) continue;

      // Amount for this period from the pure schedule; final period lands on base.
      const remaining = base - accumulated;
      if (remaining <= 0) break;
      const scheduled = schedule[idx] ?? 0;
      const amount = Math.min(scheduled, remaining);
      if (amount <= 0) continue;
      const entryDate = lastDayOfMonth(year, month);

      const je = await postJournalEntry(db, {
        org_id: orgId,
        location_id: a.location_id,
        entry_date: entryDate,
        entry_type: 'ADJUSTING',
        memo: `Depreciation — ${a.name} ${year}-${String(month).padStart(2, '0')}`,
        source_module: 'DEPRECIATION',
        source_id: a.id,
        created_by: null,
        lines: [
          { account_id: a.depreciation_expense_account_id, debit_cents: amount, credit_cents: 0, location_id: a.location_id },
          { account_id: a.accumulated_depreciation_account_id, debit_cents: 0, credit_cents: amount, location_id: a.location_id },
        ],
      });

      if (!je.success) {
        result.errors.push({ asset_id: a.id, period: `${year}-${month}`, error: je.error ?? 'post failed' });
        break;
      }

      await db.from('depreciation_runs').insert({
        org_id: orgId,
        fixed_asset_id: a.id,
        period_year: year,
        period_month: month,
        amount_cents: amount,
        gl_entry_id: je.entry_id,
      });

      accumulated += amount;
      const fullyDepreciated = accumulated >= base;
      await db
        .from('fixed_assets')
        .update({
          accumulated_depreciation_cents: accumulated,
          last_depreciation_date: entryDate,
          status: fullyDepreciated ? 'FULLY_DEPRECIATED' : 'ACTIVE',
          updated_at: new Date().toISOString(),
        })
        .eq('id', a.id);
      result.periods_posted++;
      if (fullyDepreciated) break;
    }
  }

  return result;
}
