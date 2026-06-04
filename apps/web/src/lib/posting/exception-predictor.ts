/**
 * Exception predictor (deterministic, advisory).
 *
 * Given a categorized line, flags when it probably should NOT be a plain expense:
 *   - CAPITALIZE       amount ≥ the company's capitalization threshold and the
 *                      account/description looks like a durable asset
 *   - PREPAID          description/account looks like insurance, rent, a license,
 *                      a subscription, an annual fee, a retainer, etc.
 *   - DEFERRED_REVENUE an inbound amount described as a deposit / advance / unearned
 *
 * It reads the per-company policy (capitalization_threshold_cents,
 * amortization_default_months) and is purely rule-based — no model call. The
 * result is ADVISORY: it proposes a treatment and a reason; a human (or the AI JE
 * engine, which can ask a follow-up) decides. Thresholds are per company.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type DB = SupabaseClient;

export type ExceptionTreatment = 'EXPENSE' | 'CAPITALIZE' | 'PREPAID' | 'DEFERRED_REVENUE';

export interface ExceptionPrediction {
  flag: boolean;                 // true when treatment != EXPENSE
  treatment: ExceptionTreatment;
  reason: string;
  advisory: true;
  threshold_cents?: number;
  suggested_amortization_months?: number;
}

export interface PredictExceptionInput {
  orgId: string;
  locationId: string;
  accountId: string;
  amountCents: number;
  description?: string;
  /** 'expense' (default) or 'revenue' — drives the deferred-revenue check. */
  side?: 'expense' | 'revenue';
}

const PREPAID_HINTS = /insurance|rent|subscription|licen[cs]e|annual|prepaid|retainer|warranty|maintenance contract|support contract|membership|dues/i;
const ASSET_HINTS = /equipment|vehicle|truck|computer|laptop|server|furniture|machinery|machine|building|improvement|leasehold|software|hardware|tooling|tool|trailer|forklift/i;
const DEFERRED_HINTS = /deposit|advance|retainer|prepay|unearned|upfront|milestone prepayment|mobilization/i;

const DEFAULT_THRESHOLD_CENTS = 250000; // $2,500
const DEFAULT_AMORTIZATION_MONTHS = 12;

interface AccountMeta {
  account_type: string;
  account_sub_type: string;
  name: string;
}

export async function predictException(db: DB, input: PredictExceptionInput): Promise<ExceptionPrediction> {
  const desc = (input.description ?? '').trim();

  const { data: acct } = await db
    .from('accounts')
    .select('account_type, account_sub_type, name')
    .eq('org_id', input.orgId)
    .eq('id', input.accountId)
    .maybeSingle<AccountMeta>();
  const accountName = acct?.name ?? '';
  const haystack = `${desc} ${accountName}`;

  const { data: policy } = await db
    .from('company_policies')
    .select('capitalization_threshold_cents, amortization_default_months')
    .eq('org_id', input.orgId)
    .eq('location_id', input.locationId)
    .maybeSingle();
  const threshold = Number(policy?.capitalization_threshold_cents ?? DEFAULT_THRESHOLD_CENTS);
  const months = Number(policy?.amortization_default_months ?? DEFAULT_AMORTIZATION_MONTHS);

  const noFlag = (): ExceptionPrediction => ({ flag: false, treatment: 'EXPENSE', reason: 'No exception — book as a normal expense.', advisory: true, threshold_cents: threshold });

  // Revenue side: deferred-revenue check.
  if (input.side === 'revenue' || acct?.account_type === 'REVENUE') {
    if (DEFERRED_HINTS.test(haystack)) {
      return {
        flag: true,
        treatment: 'DEFERRED_REVENUE',
        reason: 'Looks like an advance/deposit — record as deferred revenue and recognize over time, not as revenue now.',
        advisory: true,
        suggested_amortization_months: months,
      };
    }
    return noFlag();
  }

  // Expense side.
  if (PREPAID_HINTS.test(haystack)) {
    return {
      flag: true,
      treatment: 'PREPAID',
      reason: `Looks like a prepaid cost — record as a prepaid asset and amortize (default ${months} months).`,
      advisory: true,
      suggested_amortization_months: months,
    };
  }

  if (input.amountCents >= threshold) {
    const assetHint = ASSET_HINTS.test(haystack);
    return {
      flag: true,
      treatment: 'CAPITALIZE',
      reason: assetHint
        ? `$${(input.amountCents / 100).toLocaleString()} ≥ the $${(threshold / 100).toLocaleString()} capitalization threshold and looks like a durable asset — capitalize and depreciate.`
        : `$${(input.amountCents / 100).toLocaleString()} ≥ the $${(threshold / 100).toLocaleString()} capitalization threshold — review whether this should be capitalized as a fixed asset.`,
      advisory: true,
      threshold_cents: threshold,
    };
  }

  return noFlag();
}
