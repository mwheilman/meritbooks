/**
 * Propose a prepaid amortization schedule from an existing BILL line.
 *
 * A bill line coded to a prepaid category (or one a user marks "this is prepaid")
 * is the most common origin: the AP entry already sits in the ledger, and the user
 * wants to spread it. This module builds a PROPOSED schedule from that line —
 * amount = the line total, expense account = the line's account (defaulted from the
 * source, Rule 7), start = the bill date, term = a sensible default the human
 * confirms — plus the resolved prepaid-asset credit leg.
 *
 * Canon §3: this only PROPOSES. The API route writes one `ai_decisions` PROPOSED
 * audit row and returns the proposal for the human to confirm; nothing persists to
 * `posting_schedules` until they do (via the gated `POST /api/prepaid`).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildAmortizationSchedule } from './schedule';
import { resolvePrepaidAssetAccount, type ResolvedAccount } from './prepaid-asset';

/** The default term (months) when the source gives no coverage period. */
export const DEFAULT_TERM_MONTHS = 12;

export interface ProposedSchedule {
  source_type: 'BILL' | 'PREPAID_DOC' | 'MANUAL';
  source_id: string | null;
  location_id: string | null;
  department_id: string | null;
  description: string | null;
  vendor_name: string | null;
  total_cents: number;
  start_date: string; // YYYY-MM-DD
  term_months: number;
  /** DR leg — defaulted from the source line; the human can change it. */
  expense_account_id: string | null;
  expense_account_name: string | null;
  /** CR leg — the resolved prepaid asset account (null => human must pick). */
  prepaid_account_id: string | null;
  prepaid_account_name: string | null;
  /** first-period preview so the reviewer sees the monthly hit before confirming. */
  first_period_amount_cents: number;
  /** fields the UI should flag for confirmation. */
  reviewFields: string[];
}

interface BillRow {
  id: string;
  location_id: string;
  vendor_id: string | null;
  bill_date: string;
}

interface BillLineRow {
  id: string;
  bill_id: string;
  description: string | null;
  account_id: string;
  department_id: string | null;
  amount_cents: number;
}

/** Pure assembly of the proposal from its resolved parts (unit-testable). */
export function assembleProposal(args: {
  bill: BillRow;
  line: BillLineRow;
  expenseAccount: ResolvedAccount | null;
  prepaidAsset: ResolvedAccount | null;
  vendorName: string | null;
  termMonths?: number;
}): ProposedSchedule {
  const termRaw = args.termMonths ?? DEFAULT_TERM_MONTHS;
  const term = Number.isFinite(termRaw) && termRaw >= 1 ? Math.round(termRaw) : DEFAULT_TERM_MONTHS;
  const total = Math.max(0, Math.trunc(Number(args.line.amount_cents) || 0));

  let firstAmount = 0;
  if (total > 0) {
    try {
      const lines = buildAmortizationSchedule({ totalCents: total, startDate: args.bill.bill_date, months: term });
      firstAmount = lines[0]?.amountCents ?? 0;
    } catch {
      firstAmount = Math.floor(total / term);
    }
  }

  const review: string[] = ['term_months'];
  if (!args.prepaidAsset) review.push('prepaid_account_id');
  if (total <= 0) review.push('total_cents');

  return {
    source_type: 'BILL',
    source_id: args.bill.id,
    location_id: args.bill.location_id,
    department_id: args.line.department_id,
    description: args.line.description,
    vendor_name: args.vendorName,
    total_cents: total,
    start_date: args.bill.bill_date,
    term_months: term,
    expense_account_id: args.expenseAccount?.id ?? args.line.account_id,
    expense_account_name: args.expenseAccount?.name ?? null,
    prepaid_account_id: args.prepaidAsset?.id ?? null,
    prepaid_account_name: args.prepaidAsset?.name ?? null,
    first_period_amount_cents: firstAmount,
    reviewFields: Array.from(new Set(review)),
  };
}

export interface ProposeFromBillArgs {
  billId: string;
  billLineId: string;
  termMonths?: number;
}

/**
 * Load the bill + line (RLS-scoped), resolve the accounts, and build the proposal.
 * Returns null when the line can't be found in the caller's org.
 */
export async function proposeFromBill(
  supabase: SupabaseClient,
  args: ProposeFromBillArgs,
): Promise<ProposedSchedule | null> {
  const { data: lineData } = await supabase
    .from('bill_lines')
    .select('id, bill_id, description, account_id, department_id, amount_cents')
    .eq('id', args.billLineId)
    .maybeSingle<BillLineRow>();
  if (!lineData || lineData.bill_id !== args.billId) return null;

  const { data: billData } = await supabase
    .from('bills')
    .select('id, location_id, vendor_id, bill_date')
    .eq('id', args.billId)
    .maybeSingle<BillRow>();
  if (!billData) return null;

  // Expense account (the line's account) + prepaid asset (resolved by role/name).
  const [expenseAccount, prepaidAsset] = await Promise.all([
    fetchAccount(supabase, lineData.account_id),
    resolvePrepaidAssetAccount(supabase, billData.location_id),
  ]);

  // Vendor name (core master data; best-effort).
  let vendorName: string | null = null;
  if (billData.vendor_id) {
    try {
      const { data: v } = await supabase
        .schema('core')
        .from('vendors')
        .select('name, display_name')
        .eq('id', billData.vendor_id)
        .maybeSingle<{ name: string; display_name: string | null }>();
      vendorName = v ? v.display_name || v.name : null;
    } catch {
      /* name is cosmetic */
    }
  }

  return assembleProposal({
    bill: billData,
    line: lineData,
    expenseAccount,
    prepaidAsset,
    vendorName,
    termMonths: args.termMonths,
  });
}

async function fetchAccount(supabase: SupabaseClient, accountId: string): Promise<ResolvedAccount | null> {
  const { data } = await supabase
    .from('accounts')
    .select('id, name, account_number, account_type')
    .eq('id', accountId)
    .maybeSingle<ResolvedAccount>();
  return data ?? null;
}
