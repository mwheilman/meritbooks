/**
 * Posting intake / routing (deterministic, advisory).
 *
 * Takes a transaction intent, runs the exception predictor, and turns the verdict
 * into a recommended posting route with a balanced draft preview — closing the
 * loop the audit flagged (the predictor used to flag with nothing consuming it).
 *
 * This is advisory: it proposes, a human (or the AI composer that will sit on top
 * of this) approves. It does not auto-post. When the chosen account doesn't fit
 * the recommended route, or commit needs more inputs (depreciation accounts, an
 * amortization term), those are returned in `requires_inputs` rather than guessed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TransactionType, PaymentRail } from './transaction-types';
import type { JournalEntryLineInput } from '../services/gl-posting';
import { buildTransactionLines, type PostingFacts } from './posting-templates';
import { predictException, type ExceptionPrediction } from './exception-predictor';

type DB = SupabaseClient;

export interface PostingIntent {
  orgId: string;
  locationId: string;
  entryDate: string;
  accountId: string;       // the "natural" account picked for the line (expense or revenue)
  amountCents: number;
  taxCents?: number;
  description?: string;
  side?: 'expense' | 'revenue';
  rail?: PaymentRail;      // cash/card settlement; absent ⇒ an AP/AR bill flow
  jobId?: string;
  departmentId?: string;
}

export interface PostingProposal {
  prediction: ExceptionPrediction;
  recommended_type: TransactionType;
  facts: PostingFacts;
  draft_lines: JournalEntryLineInput[] | null; // null when not buildable yet
  provisioning_note?: string;                  // subledger/schedule that commit would create
  requires_inputs: string[];                   // fields needed before commit
}

async function accountType(db: DB, orgId: string, accountId: string): Promise<string | null> {
  const { data } = await db.from('accounts').select('account_type').eq('org_id', orgId).eq('id', accountId).maybeSingle();
  return (data as { account_type: string } | null)?.account_type ?? null;
}

function baseFacts(intent: PostingIntent, categoryAccountId?: string): PostingFacts {
  return {
    org_id: intent.orgId,
    location_id: intent.locationId,
    entry_date: intent.entryDate,
    amount_cents: intent.amountCents,
    tax_cents: intent.taxCents,
    category_account_id: categoryAccountId ?? intent.accountId,
    rail: intent.rail,
    job_id: intent.jobId,
    department_id: intent.departmentId,
    memo: intent.description,
  };
}

async function tryDraft(db: DB, type: TransactionType, facts: PostingFacts): Promise<JournalEntryLineInput[] | null> {
  try {
    return await buildTransactionLines(db, type, facts);
  } catch {
    return null; // not buildable with the inputs on hand; caller lists requires_inputs
  }
}

/**
 * Analyze an intent and recommend a posting route. Advisory only.
 */
export async function proposePosting(db: DB, intent: PostingIntent): Promise<PostingProposal> {
  const prediction = await predictException(db, {
    orgId: intent.orgId,
    locationId: intent.locationId,
    accountId: intent.accountId,
    amountCents: intent.amountCents,
    description: intent.description,
    side: intent.side,
  });

  const facts = baseFacts(intent);

  switch (prediction.treatment) {
    case 'CAPITALIZE': {
      const t = await accountType(db, intent.orgId, intent.accountId);
      const requires: string[] = [];
      // To commit, the asset side needs a fixed-asset account + depreciation setup.
      if (t !== 'ASSET') requires.push('asset_account_id (the picked account is not a fixed-asset account)');
      if (!intent.rail) requires.push('rail (cash/card) — or route as a vendor_bill instead');
      requires.push('depreciation_expense_account_id', 'accumulated_depreciation_account_id', 'useful_life_months');
      const draft = t === 'ASSET' && intent.rail ? await tryDraft(db, 'asset_acquisition', facts) : null;
      return {
        prediction, recommended_type: 'asset_acquisition', facts, draft_lines: draft,
        provisioning_note: 'Commit via recordAssetAcquisition → creates the fixed_assets record and starts book (and optional tax) depreciation.',
        requires_inputs: requires,
      };
    }
    case 'PREPAID': {
      const t = await accountType(db, intent.orgId, intent.accountId);
      const requires: string[] = [];
      if (t !== 'ASSET') requires.push('prepaid_account_id (the picked account is not a prepaid asset account)');
      if (!intent.rail) requires.push('rail (cash/card) — or route as a vendor_bill instead');
      requires.push('expense_account_id', `amortization_months (suggested ${prediction.suggested_amortization_months ?? 12})`);
      const draft = t === 'ASSET' && intent.rail ? await tryDraft(db, 'prepaid_purchase', facts) : null;
      return {
        prediction, recommended_type: 'prepaid_purchase', facts, draft_lines: draft,
        provisioning_note: 'Commit via recordPrepaidPurchase → books the prepaid and creates its amortization schedule.',
        requires_inputs: requires,
      };
    }
    case 'DEFERRED_REVENUE': {
      const draft = await tryDraft(db, 'deferred_revenue', facts);
      return {
        prediction, recommended_type: 'deferred_revenue', facts, draft_lines: draft,
        provisioning_note: 'Commit via recordDeferredRevenue → books the contract liability; pass recognition_months + revenue_account_id for a ratable recognition schedule, or leave to the rev-rec engine for a job/contract.',
        requires_inputs: intent.rail ? [] : ['rail (cash/card) — or it books to AR_CONTROL'],
      };
    }
    case 'EXPENSE':
    default: {
      const isRevenue = intent.side === 'revenue';
      const type: TransactionType = isRevenue ? (intent.rail ? 'cash_sale' : 'customer_invoice') : 'direct_expense';
      const draft = await tryDraft(db, type, facts);
      return {
        prediction, recommended_type: type, facts, draft_lines: draft,
        requires_inputs: draft ? [] : [isRevenue ? 'revenue account / rail' : 'rail (cash/card) — or route as a vendor_bill'],
      };
    }
  }
}
