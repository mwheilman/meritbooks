/**
 * Bill AP lifecycle (Session 18 — AP correction).
 *
 * The bill owns the full payables lifecycle end to end:
 *   PENDING -> APPROVED -> SCHEDULED -> PARTIALLY_PAID / PAID  (or -> VOIDED)
 *
 * Approval is where the GL entry posts (DR expense lines / CR Accounts Payable)
 * and where any job-tagged line's JOB_COST cost clears (gate PAYABLE_APPROVAL,
 * contract §5). The standalone Cost Approvals tab is retired; we reuse its
 * plumbing — cost_approval_rules, job_cost_attributions, core.events,
 * cost-approval.ts, job-cost-events.ts — triggered from here instead.
 *
 * On bill CREATE, each job-tagged line records a PENDING attribution (committed
 * cost), giving Projects visibility into committed-but-unapproved spend. On bill
 * APPROVE those attributions clear and emit the CLEARED JOB_COST event.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from './gl-posting';
import { approveAttribution, resolveApprover, type ResolvedApprover, type RoutingContext } from './cost-approval';
import type { CostType } from './job-cost-events';

type DB = SupabaseClient;

export interface BillLineRow {
  id: string;
  account_id: string;
  amount_cents: number;
  department_id: string | null;
  class_id: string | null;
  job_id: string | null;
  description: string | null;
}

export interface BillRow {
  id: string;
  org_id: string;
  location_id: string;
  vendor_id: string;
  bill_number: string | null;
  bill_date: string;
  due_date: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  amount_paid_cents: number;
  status: string;
  gl_entry_id: string | null;
}

/** Resolve the org's Accounts Payable control account (number 2000, else any AP control). */
export async function resolveApAccount(db: DB, orgId: string): Promise<string> {
  const byNumber = await db
    .from('accounts')
    .select('id')
    .eq('org_id', orgId)
    .eq('account_number', '2000')
    .eq('is_active', true)
    .maybeSingle();
  if (byNumber.data?.id) return byNumber.data.id as string;

  const byControl = await db
    .from('accounts')
    .select('id')
    .eq('org_id', orgId)
    .eq('is_control_account', true)
    .eq('account_sub_type', 'CURRENT_LIABILITY')
    .ilike('name', '%payable%')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  if (byControl.data?.id) return byControl.data.id as string;

  throw new Error('No Accounts Payable control account found (expected account 2000). Add it in the Chart of Accounts before approving bills.');
}

/** Load a bill + its lines, scoped to the org. */
export async function loadBillWithLines(db: DB, orgId: string, billId: string): Promise<{ bill: BillRow; lines: BillLineRow[] }> {
  const { data: bill, error } = await db
    .from('bills')
    .select('id, org_id, location_id, vendor_id, bill_number, bill_date, due_date, subtotal_cents, tax_cents, total_cents, amount_paid_cents, status, gl_entry_id')
    .eq('org_id', orgId)
    .eq('id', billId)
    .single();
  if (error || !bill) throw new Error('Bill not found');

  const { data: lines, error: lineErr } = await db
    .from('bill_lines')
    .select('id, account_id, amount_cents, department_id, class_id, job_id, description')
    .eq('bill_id', billId)
    .order('line_number', { ascending: true });
  if (lineErr) throw new Error(lineErr.message);

  return { bill: bill as BillRow, lines: (lines ?? []) as BillLineRow[] };
}

/** Resolve the approver for a whole bill from the org routing rules. */
export async function resolveBillApprover(db: DB, orgId: string, ctx: RoutingContext): Promise<ResolvedApprover> {
  return resolveApprover(db, orgId, ctx);
}

/**
 * Approve a bill: post the GL entry (DR expense lines / CR AP, plus tax), stamp the
 * job dimension on each job-tagged GL line, flip the bill to APPROVED, and clear
 * the bill's PENDING job-cost attributions (emitting CLEARED JOB_COST events).
 */
export async function approveBill(db: DB, orgId: string, billId: string, approvedBy: string) {
  const { bill, lines } = await loadBillWithLines(db, orgId, billId);

  if (bill.status === 'VOIDED') throw new Error('Cannot approve a voided bill');
  if (bill.status === 'ON_HOLD') throw new Error('Bill is on hold for vendor compliance — clear the hold before approving');
  if (bill.status !== 'PENDING') {
    // Idempotent: already past approval.
    return { id: billId, status: bill.status, gl_entry_id: bill.gl_entry_id };
  }
  if (lines.length === 0) throw new Error('Bill has no lines to post');

  const apAccountId = await resolveApAccount(db, orgId);

  // NOTE: we do NOT auto-create a period here. Per the suite contract (Rule F),
  // Books rejects posts to a missing/closed period; periods are a product of
  // setup + the Fiscal Periods screen. postJournalEntry returns a clear error
  // ("No fiscal period found …" / hard-closed) which the caller surfaces.

  // DR each expense line, CR Accounts Payable for the gross total (subtotal + tax).
  const jeLines = lines.map((l) => ({
    account_id: l.account_id,
    debit_cents: l.amount_cents,
    credit_cents: 0,
    location_id: bill.location_id,
    department_id: l.department_id ?? undefined,
    class_id: l.class_id ?? undefined,
    memo: l.description ?? undefined,
  }));

  if (bill.tax_cents > 0) {
    // Tax rides on the AP line; add a non-job sales-tax expense line so the entry balances.
    jeLines.push({
      account_id: lines[0].account_id,
      debit_cents: bill.tax_cents,
      credit_cents: 0,
      location_id: bill.location_id,
      department_id: undefined,
      class_id: undefined,
      memo: 'Sales tax',
    });
  }

  jeLines.push({
    account_id: apAccountId,
    debit_cents: 0,
    credit_cents: bill.total_cents,
    location_id: bill.location_id,
    department_id: undefined,
    class_id: undefined,
    memo: `AP: ${bill.bill_number ?? bill.id}`,
  });

  const je = await postJournalEntry(db, {
    org_id: orgId,
    location_id: bill.location_id,
    entry_date: bill.bill_date,
    entry_type: 'STANDARD',
    memo: `Bill ${bill.bill_number ?? ''} approved`.trim(),
    source_module: 'BILL',
    source_id: bill.id,
    created_by: approvedBy,
    lines: jeLines,
  });

  if (!je.success || !je.entry_id) {
    throw new Error(je.error ?? 'Failed to post bill to the general ledger');
  }

  // Stamp the job dimension onto the matching posted GL lines (line_number == index+1).
  const { data: glLines } = await db
    .from('gl_entry_lines')
    .select('id, line_number')
    .eq('gl_entry_id', je.entry_id)
    .order('line_number', { ascending: true });
  const glLineByNumber = new Map((glLines ?? []).map((g) => [(g as { line_number: number }).line_number, (g as { id: string }).id]));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.job_id) continue;
    const glLineId = glLineByNumber.get(i + 1);
    if (glLineId) {
      await db.from('gl_entry_lines').update({ job_id: line.job_id }).eq('id', glLineId);
    }
  }

  // Flip the bill to APPROVED.
  const { error: upErr } = await db
    .from('bills')
    .update({
      status: 'APPROVED',
      gl_entry_id: je.entry_id,
      approved_by_user: approvedBy,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', billId);
  if (upErr) throw new Error(upErr.message);

  // Clear the bill's PENDING attributions -> emits CLEARED JOB_COST (contract §3/§5).
  const { data: attrs } = await db
    .from('job_cost_attributions')
    .select('id')
    .eq('org_id', orgId)
    .eq('bill_id', billId)
    .eq('lifecycle', 'PENDING');

  let cleared = 0;
  for (const a of attrs ?? []) {
    await approveAttribution(db, orgId, (a as { id: string }).id, approvedBy);
    cleared++;
  }

  return { id: billId, status: 'APPROVED' as const, gl_entry_id: je.entry_id, cost_events_cleared: cleared, entry_number: je.entry_number };
}

/** Schedule an approved bill for payment. */
export async function scheduleBill(db: DB, orgId: string, billId: string, scheduledDate: string, method: string | null) {
  const { bill } = await loadBillWithLines(db, orgId, billId);
  if (bill.status !== 'APPROVED' && bill.status !== 'SCHEDULED') {
    throw new Error(`Only approved bills can be scheduled (current status: ${bill.status})`);
  }
  const { error } = await db
    .from('bills')
    .update({ status: 'SCHEDULED', scheduled_payment_date: scheduledDate, payment_method: method ?? null, updated_at: new Date().toISOString() })
    .eq('id', billId);
  if (error) throw new Error(error.message);
  return { id: billId, status: 'SCHEDULED' as const };
}

/** Record a payment against an approved/scheduled bill. */
export async function payBill(db: DB, orgId: string, billId: string, amountCents: number, paymentDate: string, method: string | null) {
  const { bill } = await loadBillWithLines(db, orgId, billId);
  if (!['APPROVED', 'SCHEDULED', 'PARTIALLY_PAID'].includes(bill.status)) {
    throw new Error(`Bill must be approved before recording a payment (current status: ${bill.status})`);
  }
  const newPaid = bill.amount_paid_cents + amountCents;
  if (newPaid > bill.total_cents) {
    throw new Error('Payment exceeds the outstanding balance');
  }
  const fullyPaid = newPaid >= bill.total_cents;
  const { error } = await db
    .from('bills')
    .update({
      amount_paid_cents: newPaid,
      status: fullyPaid ? 'PAID' : 'PARTIALLY_PAID',
      payment_method: method ?? null,
      paid_at: fullyPaid ? new Date(`${paymentDate}T00:00:00Z`).toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', billId);
  if (error) throw new Error(error.message);
  return { id: billId, status: fullyPaid ? ('PAID' as const) : ('PARTIALLY_PAID' as const), amount_paid_cents: newPaid };
}

/** Void a bill and void any of its job-cost attributions. */
export async function voidBill(db: DB, orgId: string, billId: string, reason: string) {
  const { bill } = await loadBillWithLines(db, orgId, billId);
  if (bill.amount_paid_cents > 0) {
    throw new Error('Cannot void a bill that has payments recorded against it');
  }

  const { error } = await db
    .from('bills')
    .update({ status: 'VOIDED', void_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', billId);
  if (error) throw new Error(error.message);

  // Void any attributions (PENDING or CLEARED) tied to this bill.
  const { voidAttribution } = await import('./cost-approval');
  const { data: attrs } = await db
    .from('job_cost_attributions')
    .select('id, lifecycle')
    .eq('org_id', orgId)
    .eq('bill_id', billId)
    .neq('lifecycle', 'VOIDED');
  for (const a of attrs ?? []) {
    await voidAttribution(db, orgId, (a as { id: string }).id, `Bill voided: ${reason}`);
  }

  return { id: billId, status: 'VOIDED' as const };
}

export type { CostType };
