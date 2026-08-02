/**
 * Expense-report lifecycle: build from receipts → submit → approve (SoD) →
 * reimburse (post) — plus corporate-card matching.
 *
 * ACCOUNTING (canon): an out-of-pocket reimbursement posts through the EXISTING
 * posting engine (postJournalEntry) as DR the expense accounts / CR Accounts
 * Payable — a reimbursement payable to the employee that settles through the
 * normal AP payment path. There is NO parallel money path. Corporate-card lines
 * are NEVER reimbursed here: the card charge already booked DR expense / CR Credit
 * Card Payable in the card feed, so those lines are excluded from the JE and are
 * reconciled by matching to the bank_transaction instead.
 *
 * SEGREGATION OF DUTIES: the approver must not be the submitter (enforced in
 * approveReport). Reimbursement is a separate, gated step after approval.
 *
 * IDEMPOTENCY: the reimbursement JE carries source_module='EXPENSE_REPORT',
 * source_id=<report uuid>; the report's gl_entry_id is written once and a
 * UNIQUE index (migration 081) makes the DB the double-post guarantor.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, type JournalEntryLineInput } from '../services/gl-posting';
import { resolveApAccount } from '../services/bill-ap';
import {
  evaluateExpensePolicy,
  DEFAULT_EXPENSE_POLICY,
  type ExpensePolicyConfig,
  type PolicyLineInput,
} from './policy';

type DB = SupabaseClient;

export type PaymentSource = 'OUT_OF_POCKET' | 'CORPORATE_CARD';
export type ExpenseReportStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REIMBURSED'
  | 'REJECTED';

export interface ExpenseReportLineRow {
  id: string;
  report_id: string;
  line_number: number;
  expense_date: string;
  merchant: string | null;
  description: string | null;
  account_id: string | null;
  department_id: string | null;
  class_id: string | null;
  location_id: string | null;
  amount_cents: number;
  payment_source: PaymentSource;
  receipt_id: string | null;
  bank_transaction_id: string | null;
  has_receipt: boolean;
  policy_flag: boolean;
  policy_reasons: unknown;
  billable: boolean;
  job_id: string | null;
}

export interface ExpenseReportRow {
  id: string;
  org_id: string;
  employee_id: string | null;
  location_id: string | null;
  title: string | null;
  status: ExpenseReportStatus;
  total_cents: number;
  reimbursable_cents: number;
  card_cents: number;
  policy_flag_count: number;
  submitted_by: string | null;
  approved_by: string | null;
  gl_entry_id: string | null;
}

const LINE_COLS =
  'id, report_id, line_number, expense_date, merchant, description, account_id, department_id, class_id, location_id, amount_cents, payment_source, receipt_id, bank_transaction_id, has_receipt, policy_flag, policy_reasons, billable, job_id';
const REPORT_COLS =
  'id, org_id, employee_id, location_id, title, status, total_cents, reimbursable_cents, card_cents, policy_flag_count, submitted_by, approved_by, gl_entry_id';

// ---------------------------------------------------------------------------
// PURE helpers (unit-tested without a DB)
// ---------------------------------------------------------------------------

export interface ReportTotals {
  totalCents: number;
  reimbursableCents: number;
  cardCents: number;
}

/** Deterministic roll-up of a report's line amounts by settlement path. */
export function computeReportTotals(
  lines: Pick<ExpenseReportLineRow, 'amount_cents' | 'payment_source'>[]
): ReportTotals {
  let reimbursable = 0;
  let card = 0;
  for (const l of lines) {
    if (l.payment_source === 'CORPORATE_CARD') card += l.amount_cents;
    else reimbursable += l.amount_cents;
  }
  return { totalCents: reimbursable + card, reimbursableCents: reimbursable, cardCents: card };
}

/**
 * Build the balanced reimbursement JE lines for a report — PURE so the posting
 * shape is unit-testable. DR each OUT_OF_POCKET line's expense account (carrying
 * its dimensions); CR Accounts Payable for the out-of-pocket total. Corporate-card
 * lines are excluded (booked via the card feed). Returns [] when nothing is owed.
 */
export function buildReimbursementLines(
  lines: ExpenseReportLineRow[],
  apAccountId: string,
  headerLocationId: string,
  memoRef: string
): JournalEntryLineInput[] {
  const oop = lines.filter((l) => l.payment_source === 'OUT_OF_POCKET' && l.amount_cents > 0);
  if (oop.length === 0) return [];

  const jeLines: JournalEntryLineInput[] = [];
  let total = 0;
  for (const l of oop) {
    if (!l.account_id) {
      throw new Error(`Expense line ${l.line_number} has no GL category — code it before reimbursing`);
    }
    total += l.amount_cents;
    jeLines.push({
      account_id: l.account_id,
      debit_cents: l.amount_cents,
      credit_cents: 0,
      location_id: l.location_id ?? headerLocationId,
      department_id: l.department_id ?? undefined,
      class_id: l.class_id ?? undefined,
      job_id: l.job_id ?? undefined,
      memo: l.merchant ?? l.description ?? undefined,
    });
  }

  jeLines.push({
    account_id: apAccountId,
    debit_cents: 0,
    credit_cents: total,
    location_id: headerLocationId,
    memo: `Reimbursement payable: ${memoRef}`,
  });

  return jeLines;
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

export async function loadReport(
  db: DB,
  orgId: string,
  reportId: string
): Promise<{ report: ExpenseReportRow; lines: ExpenseReportLineRow[] }> {
  const { data: report, error } = await db
    .from('expense_reports')
    .select(REPORT_COLS)
    .eq('org_id', orgId)
    .eq('id', reportId)
    .single();
  if (error || !report) throw new Error('Expense report not found');

  const { data: lines, error: lineErr } = await db
    .from('expense_report_lines')
    .select(LINE_COLS)
    .eq('org_id', orgId)
    .eq('report_id', reportId)
    .order('line_number', { ascending: true });
  if (lineErr) throw new Error(lineErr.message);

  return { report: report as ExpenseReportRow, lines: (lines ?? []) as ExpenseReportLineRow[] };
}

/**
 * Recompute policy flags + roll-up totals from the report's lines and persist
 * them. Returns the fresh totals + flagged count. Called after any line mutation
 * and on submit so the approver always sees current facts.
 */
export async function recomputeReport(
  db: DB,
  orgId: string,
  reportId: string,
  config: ExpensePolicyConfig = DEFAULT_EXPENSE_POLICY
): Promise<{ totals: ReportTotals; flaggedCount: number }> {
  const { lines } = await loadReport(db, orgId, reportId);

  const policyInput: PolicyLineInput[] = lines.map((l) => ({
    id: l.id,
    expenseDate: l.expense_date,
    merchant: l.merchant,
    categoryKey: l.account_id,
    amountCents: l.amount_cents,
    hasReceipt: l.has_receipt,
    paymentSource: l.payment_source,
  }));
  const policy = evaluateExpensePolicy(policyInput, config);
  const byLine = new Map(policy.lines.map((r) => [r.lineId, r]));

  for (const l of lines) {
    const r = byLine.get(l.id);
    const flags = r?.flags ?? [];
    await db
      .from('expense_report_lines')
      .update({ policy_flag: flags.length > 0, policy_reasons: flags })
      .eq('id', l.id)
      .eq('org_id', orgId);
  }

  const totals = computeReportTotals(lines);
  await db
    .from('expense_reports')
    .update({
      total_cents: totals.totalCents,
      reimbursable_cents: totals.reimbursableCents,
      card_cents: totals.cardCents,
      policy_flag_count: policy.flaggedCount,
    })
    .eq('id', reportId)
    .eq('org_id', orgId);

  return { totals, flaggedCount: policy.flaggedCount };
}

export interface BuildFromReceiptsInput {
  orgId: string;
  employeeId: string | null;
  createdBy: string;
  title: string | null;
  receiptIds: string[];
}

/**
 * Assemble a DRAFT report from already-captured receipts. Reuses the receipt
 * parse: each receipt's extracted merchant / amount / date / GL coding becomes a
 * proposed line the human confirms before submitting. Out-of-pocket by default.
 */
export async function buildReportFromReceipts(
  db: DB,
  input: BuildFromReceiptsInput
): Promise<{ report_id: string; line_count: number }> {
  const { orgId, employeeId, createdBy, title, receiptIds } = input;

  let receipts: Array<Record<string, unknown>> = [];
  if (receiptIds.length > 0) {
    const { data, error } = await db
      .from('receipts')
      .select('id, vendor_name, amount_cents, receipt_date, account_id, department_id, class_id, location_id, image_url')
      .eq('org_id', orgId)
      .in('id', receiptIds);
    if (error) throw new Error(error.message);
    receipts = (data ?? []) as Array<Record<string, unknown>>;
  }

  const headerLocation =
    (receipts.find((r) => r.location_id)?.location_id as string | undefined) ?? null;

  const { data: report, error: repErr } = await db
    .from('expense_reports')
    .insert({
      org_id: orgId,
      employee_id: employeeId,
      location_id: headerLocation,
      title: title ?? 'Expense report',
      status: 'DRAFT',
      created_by: createdBy,
    })
    .select('id')
    .single();
  if (repErr || !report) throw new Error(repErr?.message ?? 'Failed to create expense report');
  const reportId = (report as { id: string }).id;

  if (receipts.length > 0) {
    const lineRows = receipts.map((r, i) => ({
      org_id: orgId,
      report_id: reportId,
      line_number: i + 1,
      expense_date: (r.receipt_date as string | null) ?? new Date().toISOString().slice(0, 10),
      merchant: (r.vendor_name as string | null) ?? null,
      account_id: (r.account_id as string | null) ?? null,
      department_id: (r.department_id as string | null) ?? null,
      class_id: (r.class_id as string | null) ?? null,
      location_id: (r.location_id as string | null) ?? headerLocation,
      amount_cents: Math.abs(Number(r.amount_cents ?? 0)),
      payment_source: 'OUT_OF_POCKET' as const,
      receipt_id: r.id as string,
      has_receipt: Boolean(r.image_url),
    }));
    const { error: lineErr } = await db.from('expense_report_lines').insert(lineRows);
    if (lineErr) throw new Error(lineErr.message);
  }

  await recomputeReport(db, orgId, reportId);
  return { report_id: reportId, line_count: receipts.length };
}

/** Submit a DRAFT report for approval. Recomputes policy + totals first. */
export async function submitReport(
  db: DB,
  orgId: string,
  reportId: string,
  submittedBy: string
): Promise<{ id: string; status: ExpenseReportStatus; flaggedCount: number }> {
  const { report, lines } = await loadReport(db, orgId, reportId);
  if (report.status !== 'DRAFT' && report.status !== 'REJECTED') {
    throw new Error(`Only a draft (or rejected) report can be submitted (current: ${report.status})`);
  }
  if (lines.length === 0) throw new Error('Cannot submit an empty expense report');

  const { flaggedCount } = await recomputeReport(db, orgId, reportId);

  const { error } = await db
    .from('expense_reports')
    .update({
      status: 'SUBMITTED',
      submitted_by: submittedBy,
      submitted_at: new Date().toISOString(),
      reject_reason: null,
    })
    .eq('id', reportId)
    .eq('org_id', orgId);
  if (error) throw new Error(error.message);
  return { id: reportId, status: 'SUBMITTED', flaggedCount };
}

/**
 * Approve a submitted report. Enforces SEGREGATION OF DUTIES: the approver's
 * Clerk id must differ from the submitter's. Does not post — reimbursement is a
 * separate, gated step.
 */
export async function approveReport(
  db: DB,
  orgId: string,
  reportId: string,
  approvedBy: string
): Promise<{ id: string; status: ExpenseReportStatus }> {
  const { report } = await loadReport(db, orgId, reportId);
  if (report.status === 'APPROVED' || report.status === 'REIMBURSED') {
    return { id: reportId, status: report.status };
  }
  if (report.status !== 'SUBMITTED') {
    throw new Error(`Only a submitted report can be approved (current: ${report.status})`);
  }
  if (report.submitted_by && report.submitted_by === approvedBy) {
    throw new Error('Segregation of duties: the approver cannot be the submitter of the expense report');
  }

  const { error } = await db
    .from('expense_reports')
    .update({ status: 'APPROVED', approved_by: approvedBy, approved_at: new Date().toISOString() })
    .eq('id', reportId)
    .eq('org_id', orgId);
  if (error) throw new Error(error.message);
  return { id: reportId, status: 'APPROVED' };
}

/** Reject a submitted report back to the submitter. */
export async function rejectReport(
  db: DB,
  orgId: string,
  reportId: string,
  rejectedBy: string,
  reason: string
): Promise<{ id: string; status: ExpenseReportStatus }> {
  const { report } = await loadReport(db, orgId, reportId);
  if (report.status !== 'SUBMITTED') {
    throw new Error(`Only a submitted report can be rejected (current: ${report.status})`);
  }
  const { error } = await db
    .from('expense_reports')
    .update({
      status: 'REJECTED',
      rejected_by: rejectedBy,
      rejected_at: new Date().toISOString(),
      reject_reason: reason,
    })
    .eq('id', reportId)
    .eq('org_id', orgId);
  if (error) throw new Error(error.message);
  return { id: reportId, status: 'REJECTED' };
}

/**
 * Reimburse an APPROVED report: post the out-of-pocket JE (DR expense / CR AP)
 * through the existing posting engine and flip to REIMBURSED. Corporate-card
 * lines are excluded (booked via the card feed). Idempotent: a report already
 * carrying a gl_entry_id is not re-posted.
 */
export async function reimburseReport(
  db: DB,
  orgId: string,
  reportId: string,
  reimbursedBy: string
): Promise<{ id: string; status: ExpenseReportStatus; gl_entry_id: string | null; reimbursed_cents: number }> {
  const { report, lines } = await loadReport(db, orgId, reportId);

  if (report.status === 'REIMBURSED') {
    return { id: reportId, status: 'REIMBURSED', gl_entry_id: report.gl_entry_id, reimbursed_cents: report.reimbursable_cents };
  }
  if (report.status !== 'APPROVED') {
    throw new Error(`Only an approved report can be reimbursed (current: ${report.status})`);
  }
  if (report.gl_entry_id) {
    // Already posted — flip status idempotently without double-posting.
    await db.from('expense_reports').update({ status: 'REIMBURSED', reimbursed_at: new Date().toISOString() }).eq('id', reportId).eq('org_id', orgId);
    return { id: reportId, status: 'REIMBURSED', gl_entry_id: report.gl_entry_id, reimbursed_cents: report.reimbursable_cents };
  }

  const totals = computeReportTotals(lines);

  // Nothing out-of-pocket to reimburse (all corporate card) — no JE; just close it.
  if (totals.reimbursableCents === 0) {
    const { error } = await db
      .from('expense_reports')
      .update({ status: 'REIMBURSED', reimbursed_at: new Date().toISOString() })
      .eq('id', reportId)
      .eq('org_id', orgId);
    if (error) throw new Error(error.message);
    return { id: reportId, status: 'REIMBURSED', gl_entry_id: null, reimbursed_cents: 0 };
  }

  const headerLocationId =
    report.location_id ?? lines.find((l) => l.payment_source === 'OUT_OF_POCKET' && l.location_id)?.location_id ?? null;
  if (!headerLocationId) {
    throw new Error('Expense report has no entity/location to book the reimbursement into');
  }

  const apAccountId = await resolveApAccount(db, orgId);
  const memoRef = report.title ?? `Expense report ${reportId.slice(0, 8)}`;
  const jeLines = buildReimbursementLines(lines, apAccountId, headerLocationId, memoRef);

  const je = await postJournalEntry(db, {
    org_id: orgId,
    location_id: headerLocationId,
    entry_date: new Date().toISOString().slice(0, 10),
    entry_type: 'STANDARD',
    memo: `Expense reimbursement: ${memoRef}`,
    source_module: 'EXPENSE_REPORT',
    source_id: reportId,
    created_by: null, // uuid column; Clerk actor is text → captured on the report row
    lines: jeLines,
  });
  if (!je.success || !je.entry_id) {
    throw new Error(je.error ?? 'Failed to post the expense reimbursement to the general ledger');
  }

  const { error } = await db
    .from('expense_reports')
    .update({
      status: 'REIMBURSED',
      gl_entry_id: je.entry_id,
      reimbursed_at: new Date().toISOString(),
    })
    .eq('id', reportId)
    .eq('org_id', orgId);
  if (error) throw new Error(error.message);

  void reimbursedBy; // attribution captured via approved_by/submitted_by; actor logged upstream
  return { id: reportId, status: 'REIMBURSED', gl_entry_id: je.entry_id, reimbursed_cents: totals.reimbursableCents };
}

/**
 * Reconcile a CORPORATE_CARD line to the card feed by linking it to a
 * bank_transaction on a CREDIT_CARD account. No GL post here — the card charge
 * already booked DR expense / CR Credit Card Payable in the feed; this only
 * records the match so the expense is not also reimbursed.
 */
export async function matchCardCharge(
  db: DB,
  orgId: string,
  lineId: string,
  bankTransactionId: string
): Promise<{ id: string; bank_transaction_id: string }> {
  // Verify the bank transaction belongs to a credit-card account in this org.
  const { data: txn, error: txnErr } = await db
    .from('bank_transactions')
    .select('id, bank_account_id, amount_cents')
    .eq('id', bankTransactionId)
    .single();
  if (txnErr || !txn) throw new Error('Card transaction not found');

  const { data: acct } = await db
    .from('bank_accounts')
    .select('id, account_type')
    .eq('id', (txn as { bank_account_id: string }).bank_account_id)
    .single();
  if (!acct || (acct as { account_type: string }).account_type !== 'CREDIT_CARD') {
    throw new Error('Matched transaction is not on a corporate-card account');
  }

  const { error } = await db
    .from('expense_report_lines')
    .update({ bank_transaction_id: bankTransactionId, payment_source: 'CORPORATE_CARD' })
    .eq('id', lineId)
    .eq('org_id', orgId);
  if (error) throw new Error(error.message);
  return { id: lineId, bank_transaction_id: bankTransactionId };
}
