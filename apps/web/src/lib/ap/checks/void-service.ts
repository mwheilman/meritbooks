/**
 * Void a check (FPB §5, AC-8–10): reverse each payment on it, reopen the bills, return the
 * pay-run approvals, mark the number VOIDED.
 *
 *   payment JE in an OPEN period        → void the JE in place (VOIDED drops out of every
 *                                         POSTED-only report, netting it to zero)
 *   payment JE in SOFT_CLOSE / HARD_CLOSE → post a REVERSING entry (DR Cash / CR A/P, same
 *                                         accounts + dimensions) on the void date, which
 *                                         must fall in a period that accepts postings
 *
 * Settlement only ever cleared A/P, so the reversal only ever restores A/P — never an
 * expense. Every step is idempotent: a retry skips payments already VOIDED, finds an
 * existing reversing entry by its unique source_ref, recomputes the bill from its POSTED
 * payments, and moves approvals only RELEASED → RETURNED.
 */

import { postJournalEntry, voidJournalEntry } from '@/lib/services/gl-posting';
import { scopedWriter } from '@/lib/db/scoped-writer';
import {
  CheckError,
  loadCheck,
  loadCheckPayments,
  moveApproval,
  todayIso,
  type CheckServiceOptions,
  type DB,
} from './db';
import { isOutstanding } from './register';

interface PaymentRow {
  id: string;
  bill_id: string;
  location_id: string;
  amount_cents: number;
  payment_date: string;
  status: string;
  gl_entry_id: string | null;
}
interface EntryRow { id: string; status: string; fiscal_period_id: string; location_id: string; entry_number: string | null }
interface LineRow {
  account_id: string; debit_cents: number; credit_cents: number; location_id: string;
  department_id: string | null; class_id: string | null; item_id: string | null; job_id: string | null; memo: string | null;
}

export interface VoidInput {
  reason: string;
  /** Defaults to today; must be on/after the check date and not in the future. */
  voidDate?: string;
}

export interface VoidResult {
  checkNumber: number;
  mode: 'VOID_IN_PLACE' | 'REVERSING_ENTRY' | 'MIXED' | 'NONE';
  reversedEntryIds: string[];
  billsReopened: number;
}

type Plan =
  | { kind: 'skip'; payment: PaymentRow }
  | { kind: 'in_place'; payment: PaymentRow; entry: EntryRow }
  | { kind: 'reversing'; payment: PaymentRow; entry: EntryRow; lines: LineRow[] };

const reversalRef = (billPaymentId: string) => `check_void:${billPaymentId}`;

async function periodStatus(db: DB, orgId: string, locationId: string, date: string): Promise<string | null> {
  const { data } = await db
    .from('fiscal_periods')
    .select('status')
    .eq('org_id', orgId)
    .eq('location_id', locationId)
    .lte('start_date', date)
    .gte('end_date', date)
    .maybeSingle();
  return (data as { status: string } | null)?.status ?? null;
}

/** Plan every payment's reversal BEFORE anything changes (all-or-nothing preflight). */
async function planReversals(db: DB, orgId: string, payments: PaymentRow[], voidDate: string): Promise<Plan[]> {
  const plans: Plan[] = [];
  for (const p of payments) {
    if (p.status !== 'POSTED') { plans.push({ kind: 'skip', payment: p }); continue; }
    if (!p.gl_entry_id) throw new CheckError('A payment on this check has no journal entry to reverse; reverse it by hand.', 409);
    const { data: e, error } = await db
      .from('gl_entries')
      .select('id, status, fiscal_period_id, location_id, entry_number')
      .eq('org_id', orgId)
      .eq('id', p.gl_entry_id)
      .maybeSingle();
    if (error || !e) throw new CheckError('The payment journal entry could not be found.', 409);
    const entry = e as EntryRow;
    if (entry.status === 'VOIDED') { plans.push({ kind: 'skip', payment: p }); continue; }
    const { data: per } = await db.from('fiscal_periods').select('status').eq('id', entry.fiscal_period_id).maybeSingle();
    const origStatus = (per as { status: string } | null)?.status ?? 'OPEN';
    if (origStatus === 'OPEN') { plans.push({ kind: 'in_place', payment: p, entry }); continue; }

    const target = await periodStatus(db, orgId, entry.location_id, voidDate);
    if (!target) throw new CheckError(`There is no fiscal period for ${voidDate}, so the void can't be posted. Open the period first.`, 409);
    if (target === 'HARD_CLOSE') {
      throw new CheckError(`The payment's month is closed and ${voidDate} is in a hard-closed period too. Choose a void date in an open period.`, 409);
    }
    const { data: lines, error: lErr } = await db
      .from('gl_entry_lines')
      .select('account_id, debit_cents, credit_cents, location_id, department_id, class_id, item_id, job_id, memo')
      .eq('org_id', orgId)
      .eq('gl_entry_id', entry.id);
    if (lErr || !lines || lines.length < 2) throw new CheckError('The payment journal entry lines could not be read.', 409);
    plans.push({ kind: 'reversing', payment: p, entry, lines: lines as LineRow[] });
  }
  return plans;
}

/** Recompute a bill's paid amount from its remaining POSTED payments (idempotent reopen). */
async function reopenBill(db: DB, orgId: string, billId: string, locationId: string, opts: CheckServiceOptions): Promise<boolean> {
  const { data: bill } = await db.from('bills').select('id, total_cents, amount_paid_cents, status').eq('org_id', orgId).eq('id', billId).maybeSingle();
  const b = bill as { id: string; total_cents: number; amount_paid_cents: number; status: string } | null;
  if (!b || b.status === 'VOIDED') return false;
  const { data: pays } = await db.from('bill_payments').select('amount_cents, status').eq('org_id', orgId).eq('bill_id', billId);
  const paid = ((pays ?? []) as Array<{ amount_cents: number; status: string }>)
    .filter((p) => p.status === 'POSTED')
    .reduce((s, p) => s + Number(p.amount_cents), 0);
  const total = Number(b.total_cents);
  const status = paid >= total && total > 0 ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'APPROVED';
  if (paid === Number(b.amount_paid_cents) && status === b.status) return false;
  const patch: Record<string, unknown> = { amount_paid_cents: paid, status, updated_at: new Date().toISOString() };
  const writer = await scopedWriter(db, orgId, [locationId], { writer: opts.writer });
  if (status !== 'PAID') patch.paid_at = null;
  const { error } = await writer
    .from('bills')
    .update(patch)
    .eq('org_id', orgId)
    .eq('id', billId);
  if (error) throw new CheckError(`The payment was reversed, but the bill could not be reopened: ${error.message}`, 500);
  return true;
}

export async function voidCheck(
  db: DB,
  orgId: string,
  actor: string,
  checkId: string,
  input: VoidInput,
  opts: CheckServiceOptions = {},
): Promise<VoidResult> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new CheckError('Say why the check is being voided.');
  const today = todayIso(opts.now);
  const voidDate = input.voidDate ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(voidDate)) throw new CheckError('Enter a valid void date.');
  if (voidDate > today) throw new CheckError("The void date can't be in the future.");

  const check = await loadCheck(db, orgId, checkId);
  if (check.status === 'VOIDED') throw new CheckError(`Check ${check.check_number} is already voided.`, 409);
  if (check.status === 'SPOILED') throw new CheckError(`Check ${check.check_number} was spoiled; there is nothing to void.`, 409);
  if (check.status === 'CLEARED') {
    throw new CheckError(`Check ${check.check_number} has cleared the bank, so it can't be voided. Record a refund or adjustment instead.`, 409);
  }
  if (!isOutstanding(check.status)) throw new CheckError('This check cannot be voided.', 409);
  if (voidDate < check.check_date) throw new CheckError('The void date must be on or after the check date.');

  const links = (await loadCheckPayments(db, orgId, [checkId])).filter((l) => l.is_current || !l.reversed_at);
  const payIds = links.map((l) => l.bill_payment_id);
  const { data: payData, error: payErr } = payIds.length
    ? await db.from('bill_payments').select('id, bill_id, location_id, amount_cents, payment_date, status, gl_entry_id').eq('org_id', orgId).in('id', payIds)
    : { data: [], error: null };
  if (payErr) throw new CheckError(`Could not load the check's payments: ${payErr.message}`, 500);
  const payments = (payData ?? []) as PaymentRow[];

  const plans = await planReversals(db, orgId, payments, voidDate);
  const writer = await scopedWriter(db, orgId, [check.location_id], { writer: opts.writer });

  // Claim: one void in flight per check (a stale claim older than 10 minutes can be retaken).
  const nowIso = (opts.now ?? new Date()).toISOString();
  const staleIso = new Date((opts.now ?? new Date()).getTime() - 10 * 60_000).toISOString();
  const { data: claimed, error: claimErr } = await writer
    .from('ap_checks')
    .update({ void_requested_at: nowIso, void_requested_by: actor })
    .eq('org_id', orgId)
    .eq('id', checkId)
    .in('status', ['PRINTED', 'ISSUED', 'MAILED'])
    .or(`void_requested_at.is.null,void_requested_at.lt.${staleIso}`)
    .select('id');
  if (claimErr) throw new CheckError(`Could not start the void: ${claimErr.message}`, 500);
  if (((claimed ?? []) as unknown[]).length === 0) throw new CheckError('Someone else is voiding this check right now, or it just changed. Refresh and try again.', 409);

  const reversed: string[] = [];
  const modes = new Set<'VOID_IN_PLACE' | 'REVERSING_ENTRY'>();
  const billIds = new Set<string>();
  const memo = `Void check ${check.check_number}: ${reason}`.slice(0, 500);

  for (const plan of plans) {
    const p = plan.payment;
    billIds.add(p.bill_id);
    let reversalEntryId: string | null = null;
    if (plan.kind === 'in_place') {
      const res = await voidJournalEntry(db, orgId, plan.entry.id, null, memo, { writer: opts.writer });
      if (!res.success && !/status VOIDED/i.test(res.error ?? '')) {
        throw new CheckError(`Could not void ${plan.entry.entry_number ?? 'the payment entry'}: ${res.error ?? 'unknown error'}`, 409);
      }
      modes.add('VOID_IN_PLACE');
      reversed.push(plan.entry.id);
    } else if (plan.kind === 'reversing') {
      const res = await postJournalEntry(db, {
        org_id: orgId,
        location_id: plan.entry.location_id,
        entry_date: voidDate,
        entry_type: 'REVERSING',
        memo,
        source_module: 'BILL',
        source_id: p.bill_id,
        source_ref: reversalRef(p.id),
        created_by: null,
        lines: plan.lines.map((l) => ({
          account_id: l.account_id,
          debit_cents: Number(l.credit_cents),
          credit_cents: Number(l.debit_cents),
          location_id: l.location_id,
          department_id: l.department_id ?? undefined,
          class_id: l.class_id ?? undefined,
          item_id: l.item_id ?? undefined,
          job_id: l.job_id ?? undefined,
          memo: `Reverse: ${l.memo ?? 'bill payment'}`.slice(0, 200),
        })),
      }, { writer: opts.writer });
      if (res.success && res.entry_id) {
        reversalEntryId = res.entry_id;
      } else {
        // A retry: the unique (org, source_ref, entry_type) index already holds the reversal.
        const { data: existing } = await db
          .from('gl_entries')
          .select('id')
          .eq('org_id', orgId)
          .eq('source_ref', reversalRef(p.id))
          .eq('entry_type', 'REVERSING')
          .eq('status', 'POSTED')
          .maybeSingle();
        reversalEntryId = (existing as { id: string } | null)?.id ?? null;
        if (!reversalEntryId) throw new CheckError(`Could not post the reversing entry: ${res.error ?? 'unknown error'}`, 409);
      }
      modes.add('REVERSING_ENTRY');
      reversed.push(reversalEntryId);
    }

    if (plan.kind !== 'skip' || p.status === 'POSTED') {
      const { error } = await writer
        .from('bill_payments')
        .update({ status: 'VOIDED', voided_at: nowIso, voided_by: actor, void_reason: memo })
        .eq('org_id', orgId)
        .eq('id', p.id)
        .eq('status', 'POSTED');
      if (error) throw new CheckError(`The entry was reversed, but the payment could not be marked void: ${error.message}`, 500);
    }
    const link = links.find((l) => l.bill_payment_id === p.id);
    if (link && (link.is_current || !link.reversed_at)) {
      const { error } = await writer
        .from('ap_check_payments')
        .update({ is_current: false, reversed_at: nowIso, reversal_gl_entry_id: reversalEntryId })
        .eq('org_id', orgId)
        .eq('id', link.id);
      if (error) throw new CheckError(`Could not update the check's payment link: ${error.message}`, 500);
    }
  }

  let reopened = 0;
  for (const billId of billIds) if (await reopenBill(db, orgId, billId, check.location_id, opts)) reopened += 1;
  for (const l of links) {
    if (l.approval_id) await moveApproval(writer, orgId, l.approval_id, 'RELEASED', 'RETURNED', actor, memo);
  }

  const mode = modes.size === 0 ? 'NONE' : modes.size === 2 ? 'MIXED' : (Array.from(modes)[0] as 'VOID_IN_PLACE' | 'REVERSING_ENTRY');
  const { data: done, error: doneErr } = await writer
    .from('ap_checks')
    .update({
      status: 'VOIDED',
      void_kind: 'VOID',
      voided_at: nowIso,
      voided_by: actor,
      void_reason: reason.slice(0, 500),
      void_date: voidDate,
      reversal_mode: mode,
      reversal_entry_ids: reversed,
    })
    .eq('org_id', orgId)
    .eq('id', checkId)
    .in('status', ['PRINTED', 'ISSUED', 'MAILED'])
    .select('id');
  if (doneErr) throw new CheckError(`The payments were reversed, but the check could not be marked void: ${doneErr.message}. Void it again to finish.`, 500);
  if (((done ?? []) as unknown[]).length === 0) throw new CheckError('The check changed while it was being voided. Refresh to see its state.', 409);

  return { checkNumber: Number(check.check_number), mode, reversedEntryIds: reversed, billsReopened: reopened };
}
