/**
 * Intangible-asset amortization engine.
 *
 * An intangible is a `public.fixed_assets` row with an `INTANGIBLE_*` category, so
 * this engine REUSES the fixed-asset depreciation machinery wholesale:
 *   - the PURE per-period schedule from `lib/posting/depreciation-methods`
 *     (straight-line is the norm for intangibles; the accelerated book methods are
 *     available too and computed identically),
 *   - `postJournalEntry` for the balanced GL post, and
 *   - the `public.depreciation_runs` table as the per-(asset, period) idempotency
 *     guard, so a re-run never double-posts and the roll-forward reconstructs
 *     accumulated amortization from the same rows the tangible engine uses.
 *
 * Each period posts: DR Amortization Expense / CR Accumulated Amortization — the
 * accounts resolved BY ROLE (`resolveIntangibleAccounts`), never guessed.
 *
 * GOODWILL (and any NON_AMORTIZING category) is SKIPPED: under ASC 350 goodwill is
 * not amortized, only tested for impairment. Its book value moves solely through
 * `recordImpairment` below.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from '../services/gl-posting';
import { PostingError, resolveRole, type AccountRef } from '../posting/account-roles';
import { buildDepreciationSchedule, mapBookMethod, type DepreciationCalcMethod } from '../posting/depreciation-methods';
import { isIntangibleCategory, isNonAmortizing } from './categories';

type DB = SupabaseClient;

// ── Pure schedule helper (unit-tested) ───────────────────────────────────────

export interface IntangibleAmortizationScheduleParams {
  category: string;
  costCents: number;
  /** Residual value. Intangibles usually have zero residual; default 0. */
  salvageCents?: number;
  usefulLifeMonths: number;
  /** Stored `depreciation_method_enum` value. Non-life-based → straight-line. */
  method?: string;
}

/**
 * The per-period amortization schedule in integer cents.
 *
 * - NON_AMORTIZING categories (goodwill / indefinite-lived) return `[]` — there is
 *   no amortization schedule; value only moves on impairment.
 * - Otherwise it delegates to the SAME pure engine the tangible poster uses.
 *   Straight-line is the default; if the stored method is not a life-based book
 *   method (e.g. units-of-production / MACRS, which don't apply to intangibles) it
 *   falls back to straight-line — the accounting norm for finite-lived intangibles.
 */
export function buildIntangibleAmortizationSchedule(
  params: IntangibleAmortizationScheduleParams,
): number[] {
  if (isNonAmortizing(params.category)) return [];

  const salvage = params.salvageCents ?? 0;
  const mapped = mapBookMethod(params.method ?? 'STRAIGHT_LINE');
  const method: DepreciationCalcMethod = mapped?.method ?? 'STRAIGHT_LINE';
  const decliningFactor = mapped?.decliningFactor;

  return buildDepreciationSchedule({
    costCents: params.costCents,
    salvageCents: salvage,
    usefulLifeMonths: params.usefulLifeMonths,
    method,
    decliningFactor,
  });
}

// ── Small date helpers (kept local so the module is self-contained) ───────────

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

// ── DB-driven amortization run ────────────────────────────────────────────────

interface IntangibleAssetRow {
  id: string;
  location_id: string;
  name: string;
  category: string | null;
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

export interface AmortizationRunResult {
  asOf: string;
  assets_processed: number;
  periods_posted: number;
  amount_posted_cents: number;
  skipped: { asset_id: string; reason: string }[];
  errors: { asset_id: string; period: string; error: string }[];
}

const INTANGIBLE_SELECT =
  'id, location_id, name, category, acquisition_date, acquisition_cost_cents, salvage_value_cents, useful_life_months, depreciation_method, depreciation_expense_account_id, accumulated_depreciation_account_id, accumulated_depreciation_cents, last_depreciation_date, status';

/**
 * Post all due monthly amortization for ACTIVE intangibles up to `asOf`.
 * When `assetId` is given, restricts the run to that single asset. Goodwill and
 * other non-amortizing categories are skipped (impairment-only).
 */
export async function runAmortization(
  db: DB,
  orgId: string,
  asOf: string,
  assetId?: string,
): Promise<AmortizationRunResult> {
  let query = db
    .from('fixed_assets')
    .select(INTANGIBLE_SELECT)
    .eq('org_id', orgId)
    .eq('status', 'ACTIVE');
  if (assetId) query = query.eq('id', assetId);

  const { data, error } = await query;
  if (error) throw new PostingError(error.message);

  const assets = ((data ?? []) as IntangibleAssetRow[]).filter((a) => isIntangibleCategory(a.category));
  const result: AmortizationRunResult = {
    asOf,
    assets_processed: 0,
    periods_posted: 0,
    amount_posted_cents: 0,
    skipped: [],
    errors: [],
  };

  for (const a of assets) {
    result.assets_processed++;

    if (isNonAmortizing(a.category)) {
      result.skipped.push({ asset_id: a.id, reason: 'goodwill / indefinite-lived intangible is not amortized (impairment-only)' });
      continue;
    }

    const base = a.acquisition_cost_cents - a.salvage_value_cents;
    if (base <= 0 || a.useful_life_months <= 0) {
      result.skipped.push({ asset_id: a.id, reason: 'no amortizable base or zero useful life' });
      continue;
    }

    let schedule: number[];
    try {
      schedule = buildIntangibleAmortizationSchedule({
        category: a.category ?? '',
        costCents: a.acquisition_cost_cents,
        salvageCents: a.salvage_value_cents,
        usefulLifeMonths: a.useful_life_months,
        method: a.depreciation_method,
      });
    } catch (e) {
      result.skipped.push({ asset_id: a.id, reason: e instanceof Error ? e.message : 'schedule build failed' });
      continue;
    }
    if (schedule.length === 0) {
      result.skipped.push({ asset_id: a.id, reason: 'no amortization schedule (non-amortizing)' });
      continue;
    }

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
        memo: `Amortization — ${a.name} ${year}-${String(month).padStart(2, '0')}`,
        source_module: 'AMORTIZATION',
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
      result.periods_posted++;
      result.amount_posted_cents += amount;

      const fullyAmortized = accumulated >= base;
      await db
        .from('fixed_assets')
        .update({
          accumulated_depreciation_cents: accumulated,
          last_depreciation_date: entryDate,
          status: fullyAmortized ? 'FULLY_DEPRECIATED' : 'ACTIVE',
          updated_at: new Date().toISOString(),
        })
        .eq('id', a.id);

      if (fullyAmortized) break;
    }
  }

  return result;
}

// ── Impairment write-down (manual) ────────────────────────────────────────────

export interface ImpairmentResult {
  success: boolean;
  error?: string;
  entry_id?: string;
  entry_number?: string;
  new_accumulated_cents?: number;
  new_net_book_value_cents?: number;
}

/**
 * Resolve the impairment-loss account: a name-matched "Impairment" expense account
 * if the tenant has one, else the LOSS_ON_DISPOSAL role (an OTHER-type write-down
 * account). Throws PostingError if neither resolves — never guesses.
 */
async function resolveImpairmentLoss(db: DB, orgId: string, locationId?: string): Promise<AccountRef> {
  const { data } = await db
    .from('accounts')
    .select('id, account_type, account_sub_type, account_number, name')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .ilike('name', '%impairment%')
    .in('account_type', ['OPEX', 'OTHER'])
    .limit(1)
    .maybeSingle<{ id: string; account_type: string; account_sub_type: string; account_number: string }>();
  if (data) {
    return {
      id: data.id,
      account_type: data.account_type as AccountRef['account_type'],
      account_sub_type: data.account_sub_type as AccountRef['account_sub_type'],
      account_number: data.account_number,
    };
  }
  // Fallback: LOSS_ON_DISPOSAL is the canonical OTHER-type write-down account.
  return resolveRole(db, orgId, 'LOSS_ON_DISPOSAL', locationId);
}

/**
 * Record a manual impairment write-down on an intangible (the ASC 350 path for
 * goodwill and any impaired finite-lived intangible). Posts:
 *   DR Impairment Loss / CR Accumulated Amortization  (writes NBV down by `amountCents`)
 * and marks the asset IMPAIRED. Crediting the accumulated-amortization contra keeps
 * one consistent mechanism for both goodwill and finite-lived intangibles and keeps
 * the generated `net_book_value_cents` correct. The write-down cannot exceed the
 * asset's current net book value. RLS-scoped `db`.
 */
export async function recordImpairment(
  db: DB,
  orgId: string,
  assetId: string,
  amountCents: number,
  opts: { impairmentDate?: string; memo?: string } = {},
): Promise<ImpairmentResult> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { success: false, error: 'amountCents must be a positive integer (bigint cents)' };
  }

  const { data: assetData, error: readErr } = await db
    .from('fixed_assets')
    .select(INTANGIBLE_SELECT)
    .eq('org_id', orgId)
    .eq('id', assetId)
    .maybeSingle<IntangibleAssetRow>();
  if (readErr) return { success: false, error: readErr.message };
  if (!assetData) return { success: false, error: 'Intangible asset not found' };
  const asset = assetData;

  if (!isIntangibleCategory(asset.category)) {
    return { success: false, error: 'Asset is not an intangible' };
  }
  if (asset.status === 'DISPOSED') {
    return { success: false, error: 'Cannot impair a disposed asset' };
  }

  const netBookValue = asset.acquisition_cost_cents - asset.accumulated_depreciation_cents;
  if (amountCents > netBookValue) {
    return { success: false, error: `Impairment (${amountCents}) exceeds net book value (${netBookValue})` };
  }

  let loss: AccountRef;
  try {
    loss = await resolveImpairmentLoss(db, orgId, asset.location_id);
  } catch (e) {
    return { success: false, error: e instanceof PostingError ? e.message : 'Could not resolve an impairment-loss account' };
  }

  const entryDate = opts.impairmentDate ?? new Date().toISOString().slice(0, 10);
  const je = await postJournalEntry(db, {
    org_id: orgId,
    location_id: asset.location_id,
    entry_date: entryDate,
    entry_type: 'ADJUSTING',
    memo: (opts.memo ?? `Impairment write-down — ${asset.name}`).slice(0, 200),
    source_module: 'IMPAIRMENT',
    source_id: asset.id,
    created_by: null,
    lines: [
      { account_id: loss.id, debit_cents: amountCents, credit_cents: 0, location_id: asset.location_id },
      { account_id: asset.accumulated_depreciation_account_id, debit_cents: 0, credit_cents: amountCents, location_id: asset.location_id },
    ],
  });
  if (!je.success) return { success: false, error: je.error ?? 'Impairment post failed' };

  const newAccumulated = asset.accumulated_depreciation_cents + amountCents;
  await db
    .from('fixed_assets')
    .update({
      accumulated_depreciation_cents: newAccumulated,
      status: 'IMPAIRED',
      updated_at: new Date().toISOString(),
    })
    .eq('id', asset.id);

  return {
    success: true,
    entry_id: je.entry_id,
    entry_number: je.entry_number,
    new_accumulated_cents: newAccumulated,
    new_net_book_value_cents: asset.acquisition_cost_cents - newAccumulated,
  };
}
