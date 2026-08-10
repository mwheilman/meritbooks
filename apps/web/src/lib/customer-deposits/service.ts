/**
 * Customer deposits / retainers (migration 140) — unapplied customer cash held as
 * a LIABILITY (account role CUSTOMER_DEPOSITS, 2420) and drawn down against
 * invoices, refunded when it won't be earned.
 *
 * The GL is the book of record; `public.customer_deposits` /
 * `customer_deposit_applications` are the SUBLEDGER (who holds what, how much is
 * left). Every GL effect flows through the EXISTING balanced-JE posting service —
 * this file never hand-rolls a ledger insert:
 *
 *   • Take deposit  : DR Cash / Undeposited Funds     / CR Customer Deposits (2420)
 *   • Apply to inv  : DR Customer Deposits (2420)      / CR Accounts Receivable
 *   • Refund        : DR Customer Deposits (2420)      / CR Cash
 *
 * `applied_cents` can never exceed `amount_cents` — enforced by the DB CHECK AND
 * re-checked here (assertCanApply), plus an optimistic-concurrency guard on the
 * increment so two concurrent applies can never over-draw or double-apply.
 *
 * Money is bigint cents. Direction is DERIVED from each account's type via
 * debitCreditFor — never hard-coded — so a role remap can't invert a leg.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  postJournalEntry,
  type JournalEntryLineInput,
} from '@/lib/services/gl-posting';
import {
  resolveRole,
  resolveCashSide,
  reverseGlEntry,
  debitCreditFor,
  PostingError,
  type AccountRef,
  type Effect,
  type PaymentRail,
} from '@/lib/posting';

type DB = SupabaseClient;

export type DepositStatus = 'HELD' | 'PARTIALLY_APPLIED' | 'APPLIED' | 'REFUNDED';

/** A customer_deposits row, numbers coerced from bigint. */
export interface DepositRow {
  id: string;
  org_id: string;
  location_id: string;
  customer_id: string;
  job_id: string | null;
  deposit_date: string;
  amount_cents: number;
  applied_cents: number;
  refunded_cents: number;
  status: DepositStatus;
  currency: string;
  source_payment_id: string | null;
  journal_entry_id: string | null;
  memo: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DepositApplicationRow {
  id: string;
  org_id: string;
  deposit_id: string;
  invoice_id: string;
  amount_cents: number;
  journal_entry_id: string | null;
  applied_by: string | null;
  applied_at: string;
}

// ─── Pure helpers (unit-tested; no I/O) ──────────────────────────────────────

/** Cents still HELD on a deposit (not yet applied or refunded). Never negative. */
export function remainingCents(
  d: Pick<DepositRow, 'amount_cents' | 'applied_cents' | 'refunded_cents'>,
): number {
  return Math.max(0, d.amount_cents - d.applied_cents - d.refunded_cents);
}

/** Status implied by how much of a deposit has been applied. */
export function statusAfterApply(amountCents: number, appliedCents: number): DepositStatus {
  if (appliedCents >= amountCents) return 'APPLIED';
  if (appliedCents > 0) return 'PARTIALLY_APPLIED';
  return 'HELD';
}

/**
 * Guard a draw-down BEFORE any posting. Throws PostingError on any invalid apply,
 * making over-application impossible in code (the DB CHECK is the backstop):
 *   - amount must be a positive integer of cents
 *   - a REFUNDED deposit cannot be applied
 *   - amount cannot exceed the deposit's remaining (amount − applied − refunded)
 *   - amount cannot exceed the invoice's open balance
 */
export function assertCanApply(
  deposit: Pick<DepositRow, 'amount_cents' | 'applied_cents' | 'refunded_cents' | 'status'>,
  invoiceBalanceCents: number,
  amountCents: number,
): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new PostingError('Application amount must be a positive integer of cents');
  }
  if (deposit.status === 'REFUNDED') {
    throw new PostingError('Cannot apply a refunded deposit');
  }
  const remaining = remainingCents(deposit);
  if (amountCents > remaining) {
    throw new PostingError(
      `Application ${amountCents} exceeds the deposit's remaining balance ${remaining}`,
    );
  }
  if (amountCents > invoiceBalanceCents) {
    throw new PostingError(
      `Application ${amountCents} exceeds the invoice's open balance ${invoiceBalanceCents}`,
    );
  }
}

/** Remaining cents that can be refunded (same as remaining held). */
export function refundableCents(
  d: Pick<DepositRow, 'amount_cents' | 'applied_cents' | 'refunded_cents'>,
): number {
  return remainingCents(d);
}

/** One balanced leg, direction derived from the account's type + intended effect. */
function line(
  account: AccountRef,
  effect: Effect,
  amountCents: number,
  locationId: string,
  memo: string,
): JournalEntryLineInput {
  return {
    account_id: account.id,
    ...debitCreditFor(account.account_type, effect, amountCents, account.account_sub_type),
    location_id: locationId,
    memo,
  };
}

/** DR cash/undeposited (increase) / CR Customer Deposits 2420 (increase). */
export function buildTakeLines(
  accts: { cash: AccountRef; deposits: AccountRef },
  amountCents: number,
  locationId: string,
): JournalEntryLineInput[] {
  return [
    line(accts.cash, 'increase', amountCents, locationId, 'Customer deposit received'),
    line(accts.deposits, 'increase', amountCents, locationId, 'Customer deposits (liability)'),
  ];
}

/** DR Customer Deposits 2420 (decrease) / CR Accounts Receivable (decrease). */
export function buildApplyLines(
  accts: { deposits: AccountRef; ar: AccountRef },
  amountCents: number,
  locationId: string,
): JournalEntryLineInput[] {
  return [
    line(accts.deposits, 'decrease', amountCents, locationId, 'Apply customer deposit'),
    line(accts.ar, 'decrease', amountCents, locationId, 'Clear receivable'),
  ];
}

/** DR Customer Deposits 2420 (decrease) / CR Cash (decrease). */
export function buildRefundLines(
  accts: { deposits: AccountRef; cash: AccountRef },
  amountCents: number,
  locationId: string,
): JournalEntryLineInput[] {
  return [
    line(accts.deposits, 'decrease', amountCents, locationId, 'Refund customer deposit'),
    line(accts.cash, 'decrease', amountCents, locationId, 'Refund paid'),
  ];
}

export interface TieOut {
  subledgerCents: number;
  glBalanceCents: number;
  differenceCents: number;
  inBalance: boolean;
}

/**
 * Reconcile the subledger against the 2420 GL balance. The subledger figure is
 * the sum of each open deposit's remaining (amount − applied − refunded); the GL
 * figure is the Customer Deposits account's net (credit) balance. They must tie.
 */
export function computeTieOut(
  deposits: Array<Pick<DepositRow, 'amount_cents' | 'applied_cents' | 'refunded_cents' | 'status'>>,
  glNetBalanceCents: number,
): TieOut {
  const subledgerCents = deposits.reduce((s, d) => s + remainingCents(d), 0);
  const differenceCents = subledgerCents - glNetBalanceCents;
  return {
    subledgerCents,
    glBalanceCents: glNetBalanceCents,
    differenceCents,
    inBalance: differenceCents === 0,
  };
}

// ─── DB-facing service (composes the pure helpers + the posting service) ──────

function toNum(v: unknown): number {
  return typeof v === 'string' ? Number(v) : (v as number) ?? 0;
}

function coerceDeposit(r: Record<string, unknown>): DepositRow {
  return {
    id: r.id as string,
    org_id: r.org_id as string,
    location_id: r.location_id as string,
    customer_id: r.customer_id as string,
    job_id: (r.job_id as string) ?? null,
    deposit_date: r.deposit_date as string,
    amount_cents: toNum(r.amount_cents),
    applied_cents: toNum(r.applied_cents),
    refunded_cents: toNum(r.refunded_cents),
    status: r.status as DepositStatus,
    currency: (r.currency as string) ?? 'USD',
    source_payment_id: (r.source_payment_id as string) ?? null,
    journal_entry_id: (r.journal_entry_id as string) ?? null,
    memo: (r.memo as string) ?? null,
    created_by: (r.created_by as string) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

export interface TakeDepositInput {
  orgId: string;
  actor: string | null;
  locationId: string;
  customerId: string;
  jobId?: string | null;
  depositDate: string; // YYYY-MM-DD
  amountCents: number;
  memo?: string | null;
  currency?: string;
  /** Payment rail for the cash side; ignored when `undeposited` is true. */
  rail?: PaymentRail;
  /** Route the receipt to Undeposited Funds (1090) instead of a bank/cash account. */
  undeposited?: boolean;
  sourcePaymentId?: string | null;
}

/**
 * Record a customer deposit and post DR cash/undeposited / CR Customer Deposits
 * (2420). The subledger row stores the JE id and opens in status HELD.
 */
export async function takeDeposit(db: DB, input: TakeDepositInput): Promise<DepositRow> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new PostingError('Deposit amount must be a positive integer of cents');
  }

  const deposits = await resolveRole(db, input.orgId, 'CUSTOMER_DEPOSITS', input.locationId);
  const cash = input.undeposited
    ? await resolveRole(db, input.orgId, 'UNDEPOSITED_FUNDS', input.locationId)
    : await resolveCashSide(db, input.orgId, input.rail ?? 'ach', input.locationId);

  const lines = buildTakeLines({ cash, deposits }, input.amountCents, input.locationId);

  const je = await postJournalEntry(db, {
    org_id: input.orgId,
    location_id: input.locationId,
    entry_date: input.depositDate,
    memo: input.memo ?? 'Customer deposit',
    source_module: 'AR',
    created_by: input.actor,
    lines,
  });
  if (!je.success || !je.entry_id) {
    throw new PostingError(je.error ?? 'Failed to post customer deposit');
  }

  const { data, error } = await db
    .from('customer_deposits')
    .insert({
      org_id: input.orgId,
      location_id: input.locationId,
      customer_id: input.customerId,
      job_id: input.jobId ?? null,
      deposit_date: input.depositDate,
      amount_cents: input.amountCents,
      status: 'HELD',
      currency: input.currency ?? 'USD',
      source_payment_id: input.sourcePaymentId ?? null,
      journal_entry_id: je.entry_id,
      memo: input.memo ?? null,
      created_by: input.actor,
    })
    .select('*')
    .single();

  if (error || !data) {
    // The JE posted but the subledger insert failed — reverse so we don't leave
    // an unbacked 2420 credit.
    await reverseGlEntry(db, input.orgId, je.entry_id, 'Deposit subledger insert failed');
    throw new PostingError(error?.message ?? 'Failed to record customer deposit');
  }

  return coerceDeposit(data);
}

interface InvoiceRow {
  id: string;
  location_id: string;
  balance_cents: number;
  amount_paid_cents: number;
  total_cents: number;
  status: string;
  currency: string | null;
  invoice_number: string;
}

export interface ApplyDepositInput {
  orgId: string;
  actor: string | null;
  depositId: string;
  invoiceId: string;
  amountCents: number;
}

export interface ApplyDepositResult {
  application_id: string;
  gl_entry_id: string;
  deposit_status: DepositStatus;
  deposit_remaining_cents: number;
  invoice_status: string;
}

/**
 * Draw a deposit down against an open invoice: post DR 2420 / CR AR, insert a
 * customer_deposit_applications row, advance the invoice, and increment
 * applied_cents under an OPTIMISTIC-CONCURRENCY guard so a race can never
 * over-apply or double-apply. If the guarded increment loses the race, the JE is
 * reversed and the application row removed — the GL stays the guarantor.
 */
export async function applyDeposit(db: DB, input: ApplyDepositInput): Promise<ApplyDepositResult> {
  const { data: depRaw, error: depErr } = await db
    .from('customer_deposits')
    .select('*')
    .eq('org_id', input.orgId)
    .eq('id', input.depositId)
    .maybeSingle();
  if (depErr || !depRaw) throw new PostingError('Deposit not found');
  const deposit = coerceDeposit(depRaw);

  const { data: invRaw, error: invErr } = await db
    .from('invoices')
    .select('id, location_id, balance_cents, amount_paid_cents, total_cents, status, currency, invoice_number')
    .eq('org_id', input.orgId)
    .eq('id', input.invoiceId)
    .maybeSingle<InvoiceRow>();
  if (invErr || !invRaw) throw new PostingError('Invoice not found');
  const invoice = invRaw;
  const invoiceBalance = toNum(invoice.balance_cents);

  // Same-company guard: the 2420 liability sits at the deposit's company and the
  // AR it clears must be at that same company, otherwise the two legs post to
  // different locations and the per-company subledger⇄GL tie-out breaks. A cross-
  // company draw-down would need an intercompany entry (out of scope here).
  if (invoice.location_id !== deposit.location_id) {
    throw new PostingError(
      'Deposit and invoice belong to different companies; apply against an invoice in the same company.',
    );
  }

  // Currency must match — no FX conversion in this lane.
  if ((invoice.currency ?? 'USD') !== deposit.currency) {
    throw new PostingError(
      `Currency mismatch: deposit is ${deposit.currency}, invoice ${invoice.invoice_number} is ${invoice.currency ?? 'USD'}`,
    );
  }

  assertCanApply(deposit, invoiceBalance, input.amountCents);

  const deposits = await resolveRole(db, input.orgId, 'CUSTOMER_DEPOSITS', deposit.location_id);
  const ar = await resolveRole(db, input.orgId, 'AR_CONTROL');

  const lines = buildApplyLines({ deposits, ar }, input.amountCents, invoice.location_id);

  const je = await postJournalEntry(db, {
    org_id: input.orgId,
    location_id: invoice.location_id,
    entry_date: new Date().toISOString().slice(0, 10),
    memo: `Apply deposit to ${invoice.invoice_number}`,
    source_module: 'AR',
    source_id: invoice.id,
    created_by: input.actor,
    lines,
  });
  if (!je.success || !je.entry_id) throw new PostingError(je.error ?? 'Failed to post deposit application');

  const { data: appRow, error: appErr } = await db
    .from('customer_deposit_applications')
    .insert({
      org_id: input.orgId,
      deposit_id: deposit.id,
      invoice_id: invoice.id,
      amount_cents: input.amountCents,
      journal_entry_id: je.entry_id,
      applied_by: input.actor,
    })
    .select('id')
    .single();
  if (appErr || !appRow) {
    await reverseGlEntry(db, input.orgId, je.entry_id, 'Deposit application insert failed');
    throw new PostingError(appErr?.message ?? 'Failed to record deposit application');
  }

  // Optimistic-concurrency increment: only succeeds if applied_cents is still the
  // value we validated against. A racing apply would have moved it, so the WHERE
  // matches zero rows and we unwind. (The DB CHECK applied<=amount is the backstop.)
  const newApplied = deposit.applied_cents + input.amountCents;
  const newStatus = statusAfterApply(deposit.amount_cents, newApplied);
  const { data: updated, error: updErr } = await db
    .from('customer_deposits')
    .update({ applied_cents: newApplied, status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', deposit.id)
    .eq('org_id', input.orgId)
    .eq('applied_cents', deposit.applied_cents)
    .select('id');
  if (updErr || !updated || updated.length === 0) {
    // Lost the race (or CHECK rejected). Unwind both the subledger row and the JE.
    await db.from('customer_deposit_applications').delete().eq('id', appRow.id).eq('org_id', input.orgId);
    await reverseGlEntry(db, input.orgId, je.entry_id, 'Concurrent deposit application; unwound');
    throw new PostingError('Deposit changed concurrently; application was not applied. Retry.');
  }

  // Advance the invoice (applying a deposit settles AR just like a cash receipt).
  const newPaid = toNum(invoice.amount_paid_cents) + input.amountCents;
  const invStatus = newPaid >= toNum(invoice.total_cents) ? 'PAID' : 'PARTIALLY_PAID';
  await db
    .from('invoices')
    .update({ amount_paid_cents: newPaid, status: invStatus, updated_at: new Date().toISOString() })
    .eq('id', invoice.id)
    .eq('org_id', input.orgId);

  return {
    application_id: appRow.id as string,
    gl_entry_id: je.entry_id,
    deposit_status: newStatus,
    deposit_remaining_cents: remainingCents({
      amount_cents: deposit.amount_cents,
      applied_cents: newApplied,
      refunded_cents: deposit.refunded_cents,
    }),
    invoice_status: invStatus,
  };
}

export interface RefundDepositInput {
  orgId: string;
  actor: string | null;
  depositId: string;
  refundDate?: string; // YYYY-MM-DD; defaults to today
  rail?: PaymentRail;
}

export interface RefundDepositResult {
  gl_entry_id: string;
  refunded_cents: number;
  status: DepositStatus;
}

/**
 * Refund the UNAPPLIED remainder of a deposit: post DR 2420 / CR cash for the
 * remaining held amount and mark the deposit REFUNDED. Guarded by optimistic
 * concurrency on refunded_cents so it can't double-refund.
 */
export async function refundDeposit(db: DB, input: RefundDepositInput): Promise<RefundDepositResult> {
  const { data: depRaw, error: depErr } = await db
    .from('customer_deposits')
    .select('*')
    .eq('org_id', input.orgId)
    .eq('id', input.depositId)
    .maybeSingle();
  if (depErr || !depRaw) throw new PostingError('Deposit not found');
  const deposit = coerceDeposit(depRaw);

  if (deposit.status === 'REFUNDED') throw new PostingError('Deposit is already refunded');
  const remaining = refundableCents(deposit);
  if (remaining <= 0) throw new PostingError('Deposit has no unapplied balance to refund');

  const deposits = await resolveRole(db, input.orgId, 'CUSTOMER_DEPOSITS', deposit.location_id);
  const cash = await resolveCashSide(db, input.orgId, input.rail ?? 'ach', deposit.location_id);

  const refundDate = input.refundDate ?? new Date().toISOString().slice(0, 10);
  const lines = buildRefundLines({ deposits, cash }, remaining, deposit.location_id);

  const je = await postJournalEntry(db, {
    org_id: input.orgId,
    location_id: deposit.location_id,
    entry_date: refundDate,
    memo: 'Refund customer deposit',
    source_module: 'AR',
    source_id: deposit.journal_entry_id ?? undefined,
    created_by: input.actor,
    lines,
  });
  if (!je.success || !je.entry_id) throw new PostingError(je.error ?? 'Failed to post deposit refund');

  const newRefunded = deposit.refunded_cents + remaining;
  const { data: updated, error: updErr } = await db
    .from('customer_deposits')
    .update({ refunded_cents: newRefunded, status: 'REFUNDED', updated_at: new Date().toISOString() })
    .eq('id', deposit.id)
    .eq('org_id', input.orgId)
    .eq('refunded_cents', deposit.refunded_cents)
    .select('id');
  if (updErr || !updated || updated.length === 0) {
    await reverseGlEntry(db, input.orgId, je.entry_id, 'Concurrent deposit refund; unwound');
    throw new PostingError('Deposit changed concurrently; refund was not recorded. Retry.');
  }

  return { gl_entry_id: je.entry_id, refunded_cents: newRefunded, status: 'REFUNDED' };
}

// ─── Reads ────────────────────────────────────────────────────────────────

export interface ListDepositsFilter {
  locationId?: string;
  customerId?: string;
  status?: DepositStatus | 'ALL';
}

/** Fetch deposits for the org (RLS-scoped via the passed client), newest first. */
export async function listDeposits(db: DB, orgId: string, filter: ListDepositsFilter = {}): Promise<DepositRow[]> {
  let q = db
    .from('customer_deposits')
    .select('*')
    .eq('org_id', orgId)
    .order('deposit_date', { ascending: false });
  if (filter.locationId) q = q.eq('location_id', filter.locationId);
  if (filter.customerId) q = q.eq('customer_id', filter.customerId);
  if (filter.status && filter.status !== 'ALL') q = q.eq('status', filter.status);
  const { data, error } = await q;
  if (error) throw new PostingError(error.message);
  return (data ?? []).map((r) => coerceDeposit(r as Record<string, unknown>));
}

/**
 * The 2420 Customer Deposits net (credit) balance from the GL, optionally scoped
 * to one company. Reads the canonical v_trial_balance view (POSTED entries only),
 * so it always agrees with the balance sheet.
 */
export async function getDepositsGlBalanceCents(
  db: DB,
  orgId: string,
  locationId?: string,
): Promise<number> {
  const account = await resolveRole(db, orgId, 'CUSTOMER_DEPOSITS', locationId);
  let q = db
    .from('v_trial_balance')
    .select('net_balance, location_id')
    .eq('org_id', orgId)
    .eq('account_id', account.id);
  if (locationId) q = q.eq('location_id', locationId);
  const { data, error } = await q;
  if (error) throw new PostingError(error.message);
  return (data ?? []).reduce((s, r) => s + toNum((r as { net_balance: unknown }).net_balance), 0);
}
