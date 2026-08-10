/**
 * Provisioning services — close the §1 disconnects between a posted entry and the
 * subledger / schedule it implies. Each posts the GL through the existing
 * deterministic template, then creates the record or schedule that makes the
 * downstream engine (depreciation / amortization / recognition) actually run.
 *
 * Pattern mirrors recordBillPayment: templates stay pure-GL; side effects live in
 * services. created_by is null (Clerk ids are text; GL author columns are uuid).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postTransaction, type PostingFacts } from './posting-templates';
import { resolveRole } from './account-roles';
import { createSchedule } from './schedule-engine';
import { reverseGlEntry } from './lifecycle';

type DB = SupabaseClient;

export interface ProvisionResult {
  success: boolean;
  entry_id?: string;
  entry_number?: string;
  /** id of the created subledger record (asset) or schedule, when applicable. */
  provisioned_id?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Asset acquisition → fixed_assets row (book) + parallel tax track
// ---------------------------------------------------------------------------

export interface AssetAcquisitionInput {
  facts: PostingFacts; // asset_acquisition facts; category_account_id = the asset account
  name: string;
  category?: string;
  /** Book depreciation. acquisition_cost defaults to amount + tax. */
  useful_life_months: number;
  depreciation_expense_account_id: string;
  accumulated_depreciation_account_id: string;
  salvage_value_cents?: number;
  depreciation_method?: 'STRAIGHT_LINE' | 'DOUBLE_DECLINING' | 'UNITS_OF_PRODUCTION';
  acquisition_date?: string; // defaults to facts.entry_date
  /** Optional parallel tax track. Omit → tax = book (tax_method NONE). */
  tax?: {
    method: 'SL' | 'MACRS' | 'SECTION_179' | 'BONUS';
    recovery_years?: number;       // MACRS GDS class
    convention?: 'HALF_YEAR' | 'MID_QUARTER' | 'MID_MONTH';
    life_months?: number;          // SL tax life
    section_179_cents?: number;    // caller supplies the allowed amount
    bonus_pct?: number;            // 0..100
  };
}

export async function recordAssetAcquisition(
  db: DB,
  input: AssetAcquisitionInput,
  opts: { created_by: string | null }
): Promise<ProvisionResult> {
  const { facts } = input;
  if (!facts.category_account_id) return { success: false, error: 'category_account_id (asset account) is required' };

  const posted = await postTransaction(db, 'asset_acquisition', facts, { created_by: opts.created_by });
  if (!posted.success) return { success: false, error: posted.error };

  const cost = facts.amount_cents + (facts.tax_cents ?? 0);
  const { data, error } = await db
    .from('fixed_assets')
    .insert({
      org_id: facts.org_id,
      location_id: facts.location_id,
      name: input.name,
      category: input.category ?? null,
      acquisition_date: input.acquisition_date ?? facts.entry_date,
      acquisition_cost_cents: cost,
      salvage_value_cents: input.salvage_value_cents ?? 0,
      useful_life_months: input.useful_life_months,
      depreciation_method: input.depreciation_method ?? 'STRAIGHT_LINE',
      asset_account_id: facts.category_account_id,
      depreciation_expense_account_id: input.depreciation_expense_account_id,
      accumulated_depreciation_account_id: input.accumulated_depreciation_account_id,
      tax_method: input.tax?.method ?? 'NONE',
      tax_recovery_years: input.tax?.recovery_years ?? null,
      tax_convention: input.tax?.convention ?? 'HALF_YEAR',
      tax_life_months: input.tax?.life_months ?? null,
      section_179_cents: input.tax?.section_179_cents ?? 0,
      bonus_pct: input.tax?.bonus_pct ?? null,
    })
    .select('id')
    .single();

  if (error) {
    // The GL posted but the subledger insert failed. Mirror the customer-deposit take
    // path: reverse the JE so we never leave an orphaned acquisition entry with no
    // fixed_assets row (GL⇄register drift). The subledger row and the GL post now
    // commit together — either both exist or neither does.
    if (posted.entry_id) {
      await reverseGlEntry(db, facts.org_id, posted.entry_id, 'Fixed-asset subledger insert failed');
    }
    return { success: false, error: `Fixed-asset insert failed; GL entry reversed: ${error.message}` };
  }
  return { success: true, entry_id: posted.entry_id, entry_number: posted.entry_number, provisioned_id: (data as { id: string }).id };
}

// ---------------------------------------------------------------------------
// Prepaid purchase → prepaid asset + amortization schedule
// ---------------------------------------------------------------------------

export interface PrepaidPurchaseInput {
  facts: PostingFacts;          // prepaid_purchase facts; category_account_id = prepaid asset account
  amortization_months: number;
  expense_account_id: string;   // the account the prepaid amortizes INTO
  start_date?: string;          // defaults to facts.entry_date
}

export async function recordPrepaidPurchase(
  db: DB,
  input: PrepaidPurchaseInput,
  opts: { created_by: string | null }
): Promise<ProvisionResult> {
  const { facts } = input;
  if (!facts.category_account_id) return { success: false, error: 'category_account_id (prepaid asset account) is required' };
  if (input.amortization_months < 1) return { success: false, error: 'amortization_months must be >= 1' };

  const posted = await postTransaction(db, 'prepaid_purchase', facts, { created_by: opts.created_by });
  if (!posted.success) return { success: false, error: posted.error };

  // Amortize the prepaid base (exclude tax folded into the GL cost). If the schedule
  // insert fails, reverse the JE — never leave a prepaid GL debit with no amortization
  // schedule behind it (same GL⇄subledger safe-ordering as the asset path).
  let schedule: { id: string };
  try {
    schedule = await createSchedule(db, {
      orgId: facts.org_id,
      locationId: facts.location_id,
      scheduleType: 'PREPAID_AMORTIZATION',
      debitAccountId: input.expense_account_id,
      creditAccountId: facts.category_account_id,
      totalCents: facts.amount_cents,
      months: input.amortization_months,
      startDate: input.start_date ?? facts.entry_date,
      departmentId: facts.department_id,
      sourceType: 'PREPAID_PURCHASE',
      sourceId: posted.entry_id,
      memo: facts.memo ?? 'Prepaid amortization',
    });
  } catch (e) {
    if (posted.entry_id) {
      await reverseGlEntry(db, facts.org_id, posted.entry_id, 'Prepaid amortization schedule creation failed');
    }
    return { success: false, error: `Prepaid schedule creation failed; GL entry reversed: ${e instanceof Error ? e.message : 'unknown'}` };
  }

  return { success: true, entry_id: posted.entry_id, entry_number: posted.entry_number, provisioned_id: schedule.id };
}

// ---------------------------------------------------------------------------
// Deferred revenue → recognition schedule (ratable case only)
// ---------------------------------------------------------------------------

export interface DeferredRevenueInput {
  facts: PostingFacts;          // deferred_revenue facts
  /**
   * Ratable recognition over N months (subscription / service contract). Omit for
   * a job/contract deferral (the rev-rec engine recognizes those per method) or a
   * refundable customer deposit (facts.as_customer_deposit — never auto-recognized).
   */
  recognition_months?: number;
  revenue_account_id?: string;  // required when recognition_months is set
  start_date?: string;
}

export async function recordDeferredRevenue(
  db: DB,
  input: DeferredRevenueInput,
  opts: { created_by: string | null }
): Promise<ProvisionResult> {
  const { facts } = input;
  const posted = await postTransaction(db, 'deferred_revenue', facts, { created_by: opts.created_by });
  if (!posted.success) return { success: false, error: posted.error };

  // A refundable customer deposit is never earned ratably — no recognition schedule.
  if (facts.as_customer_deposit) {
    return { success: true, entry_id: posted.entry_id, entry_number: posted.entry_number };
  }
  if (!input.recognition_months) {
    // Job/contract deferral — rev-rec engine handles recognition per method.
    return { success: true, entry_id: posted.entry_id, entry_number: posted.entry_number };
  }
  if (!input.revenue_account_id) return { success: false, error: 'revenue_account_id is required when recognition_months is set' };

  const deferred = await resolveRole(db, facts.org_id, 'DEFERRED_REVENUE');
  let schedule: { id: string };
  try {
    schedule = await createSchedule(db, {
      orgId: facts.org_id,
      locationId: facts.location_id,
      scheduleType: 'DEFERRED_REVENUE',
      debitAccountId: deferred.id,
      creditAccountId: input.revenue_account_id,
      totalCents: facts.amount_cents,
      months: input.recognition_months,
      startDate: input.start_date ?? facts.entry_date,
      departmentId: facts.department_id,
      sourceType: 'DEFERRED_REVENUE',
      sourceId: posted.entry_id,
      memo: facts.memo ?? 'Deferred revenue recognition',
    });
  } catch (e) {
    if (posted.entry_id) {
      await reverseGlEntry(db, facts.org_id, posted.entry_id, 'Deferred-revenue recognition schedule creation failed');
    }
    return { success: false, error: `Deferred-revenue schedule creation failed; GL entry reversed: ${e instanceof Error ? e.message : 'unknown'}` };
  }

  return { success: true, entry_id: posted.entry_id, entry_number: posted.entry_number, provisioned_id: schedule.id };
}
