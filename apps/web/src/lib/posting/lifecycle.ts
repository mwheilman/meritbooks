/**
 * Settlement lifecycle (GATE 2).
 *
 * Two-step obligations (AP, AR, credit card) are recorded first and settled
 * later. The settlement must CLEAR the obligation, not create a new cost — the
 * #1 real-world bookkeeping error and the gap the Session-20 audit found. This
 * service is the single place settlement posts:
 *
 *   - recordBillPayment      DR Accounts Payable / CR cash  (clears the bill)   [gap 1]
 *   - reverseGlEntry         void-and-reverse a posted entry                    [gap 2]
 *   - recordCustomerPayment  DR cash / CR Accounts Receivable (clears invoice)  [gap 5]
 *
 * Direction is derived from the resolved account's type (never hard-coded), and
 * the cash side adapts to the rail: a bank/cash account DECREASES, a credit-card
 * payable INCREASES (paying a bill on a card moves the liability, it isn't cash).
 *
 * GL author columns are uuid and Clerk ids are text (migration 018): we write
 * NULL to the GL author column and capture the actor as text on the sub-ledger.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, voidJournalEntry } from '../services/gl-posting';
import { debitCreditFor, type Effect } from './account-direction';
import { resolveRole, resolveCashSide, getAccountRef, PostingError, type AccountRef } from './account-roles';
import { enforcePaymentAllowed } from '../services/vendor-compliance';
import type { PaymentRail } from './transaction-types';

type DB = SupabaseClient;

/**
 * Resolve the OPERATIONAL org id.
 *
 * SECURITY: prefer the caller's VERIFIED org — the Clerk `org_id` claim exposed
 * as `ctx.orgId`, which is exactly what `get_org_id()` enforces in RLS. Callers
 * on an authenticated (money/write) path MUST pass it so the operational org can
 * never diverge from the authorized tenant.
 *
 * The `select id from core.organizations limit 1` below is a TRANSITIONAL
 * fallback for session-less/internal callers that have no claim; it is NOT a
 * tenant selector and must never override a supplied claim. Backward-compatible:
 * callers passing nothing still get the first-org lookup.
 */
export async function resolveOrgId(db: DB, preferredOrgId?: string | null): Promise<string> {
  if (typeof preferredOrgId === 'string' && preferredOrgId.length > 0) return preferredOrgId;
  const { data, error } = await db.schema('core').from('organizations').select('id').limit(1).maybeSingle();
  if (error) throw new PostingError(`Could not resolve organization: ${error.message}`);
  const id = (data as { id: string } | null)?.id;
  if (!id) throw new PostingError('No organization found in core.organizations');
  return id;
}

/** Map the UI payment-method enum to a posting rail. */
export function methodToRail(method: string | null | undefined): PaymentRail {
  switch ((method ?? '').toUpperCase()) {
    case 'CASH': return 'cash';
    case 'CHECK': return 'check';
    case 'WIRE': return 'wire';
    case 'CREDIT_CARD': return 'credit_card';
    case 'ACH':
    case 'OTHER':
    default: return 'ach';
  }
}

/** The effect a settlement has on its cash-side account, by account type. */
function cashSideEffect(cash: AccountRef, direction: 'pay' | 'receive'): Effect {
  // Paying: an asset (bank/cash) decreases; a liability (credit card) increases.
  // Receiving: an asset (bank/cash) increases.
  if (cash.account_type === 'LIABILITY') return direction === 'pay' ? 'increase' : 'decrease';
  return direction === 'pay' ? 'decrease' : 'increase';
}

interface BillRow {
  id: string;
  location_id: string;
  vendor_id: string;
  total_cents: number;
  amount_paid_cents: number;
  status: string;
}

export interface RecordBillPaymentInput {
  orgId: string;
  billId: string;
  amountCents: number;
  paymentDate: string; // YYYY-MM-DD
  method?: string | null;
  rail?: PaymentRail;
  /** Explicit cash-side GL account (e.g. the bank feed's bank account); else resolved by rail. */
  cashAccountId?: string;
  bankTransactionId?: string;
  createdBy?: string | null;
}

export interface BillPaymentResult {
  payment_id: string;
  gl_entry_id: string | null;
  status: 'PAID' | 'PARTIALLY_PAID';
  amount_paid_cents: number;
}

/**
 * Record a payment against a bill: post DR AP / CR cash, write the bill_payments
 * row, and advance the bill balance/status. Clears AP — never re-expenses.
 */
export async function recordBillPayment(db: DB, input: RecordBillPaymentInput): Promise<BillPaymentResult> {
  const { data: billData, error } = await db
    .from('bills')
    .select('id, location_id, vendor_id, total_cents, amount_paid_cents, status')
    .eq('org_id', input.orgId)
    .eq('id', input.billId)
    .single<BillRow>();
  if (error || !billData) throw new PostingError('Bill not found');

  if (!['APPROVED', 'SCHEDULED', 'PARTIALLY_PAID'].includes(billData.status)) {
    throw new PostingError(`Bill must be approved before payment (status: ${billData.status})`);
  }

  // Vendor-compliance gate: refuse payment to a vendor on hold (missing/expired
  // W-9 or COI) unless an active override applies. A ONE_TIME override is
  // consumed here. Re-checked at PAY time, not just at bill creation, because
  // documents can lapse after a bill is approved.
  await enforcePaymentAllowed(db, input.orgId, billData.vendor_id, input.billId, input.createdBy ?? null);

  const balance = billData.total_cents - billData.amount_paid_cents;
  if (input.amountCents > balance) {
    throw new PostingError(`Payment ${input.amountCents} exceeds outstanding balance ${balance}`);
  }

  const rail = input.rail ?? methodToRail(input.method);
  const ap = await resolveRole(db, input.orgId, 'AP_CONTROL');
  const cash = input.cashAccountId
    ? await getAccountRef(db, input.orgId, input.cashAccountId)
    : await resolveCashSide(db, input.orgId, rail, billData.location_id);

  const apLine = {
    account_id: ap.id,
    ...debitCreditFor(ap.account_type, 'decrease', input.amountCents, ap.account_sub_type),
    location_id: billData.location_id,
    memo: 'Pay accounts payable',
  };
  const cashLine = {
    account_id: cash.id,
    ...debitCreditFor(cash.account_type, cashSideEffect(cash, 'pay'), input.amountCents, cash.account_sub_type),
    location_id: billData.location_id,
    memo: 'Bill payment',
  };

  const je = await postJournalEntry(db, {
    org_id: input.orgId,
    location_id: billData.location_id,
    entry_date: input.paymentDate,
    memo: 'Bill payment',
    source_module: 'BILL',
    source_id: input.billId,
    created_by: null,
    lines: [apLine, cashLine],
  });
  if (!je.success || !je.entry_id) throw new PostingError(je.error ?? 'Failed to post bill payment');

  const { data: payment, error: payErr } = await db
    .from('bill_payments')
    .insert({
      org_id: input.orgId,
      bill_id: input.billId,
      location_id: billData.location_id,
      amount_cents: input.amountCents,
      payment_date: input.paymentDate,
      method: input.method ?? null,
      rail,
      cash_account_id: cash.id,
      bank_transaction_id: input.bankTransactionId ?? null,
      gl_entry_id: je.entry_id,
      created_by: input.createdBy ?? null,
    })
    .select('id')
    .single();
  if (payErr || !payment) throw new PostingError(payErr?.message ?? 'Failed to record payment');

  const newPaid = billData.amount_paid_cents + input.amountCents;
  const status: 'PAID' | 'PARTIALLY_PAID' = newPaid >= billData.total_cents ? 'PAID' : 'PARTIALLY_PAID';
  await db
    .from('bills')
    .update({
      amount_paid_cents: newPaid,
      status,
      paid_at: status === 'PAID' ? new Date(`${input.paymentDate}T00:00:00Z`).toISOString() : null,
      payment_method: input.method ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.billId);

  return { payment_id: payment.id as string, gl_entry_id: je.entry_id, status, amount_paid_cents: newPaid };
}

/** Void-and-reverse a posted GL entry (used when a bill/invoice is voided). */
export async function reverseGlEntry(db: DB, orgId: string, glEntryId: string, reason: string) {
  return voidJournalEntry(db, orgId, glEntryId, null, reason);
}

export interface PaymentApplication {
  invoice_id: string;
  amount_cents: number;
}

export interface RecordCustomerPaymentInput {
  orgId: string;
  customerId: string;
  locationId: string;
  paymentDate: string;
  amountCents: number;
  method?: string | null;
  rail?: PaymentRail;
  cashAccountId?: string;
  referenceNumber?: string | null;
  bankAccountId?: string | null;
  applications: PaymentApplication[];
}

export interface CustomerPaymentResult {
  payment_id: string;
  gl_entry_id: string | null;
  applications_count: number;
}

/**
 * Record a customer payment: post DR cash / CR AR, write customer_payments +
 * payment_applications, and advance each invoice. Clears AR — closes gap 5
 * (the old path resolved org from an empty Clerk id and used impossible account
 * number ranges, so it silently posted nothing).
 */
export async function recordCustomerPayment(db: DB, input: RecordCustomerPaymentInput): Promise<CustomerPaymentResult> {
  const totalApplied = input.applications.reduce((s, a) => s + a.amount_cents, 0);
  if (totalApplied > input.amountCents) {
    throw new PostingError('Applied amounts exceed payment total');
  }
  for (const app of input.applications) {
    const { data: inv } = await db
      .from('invoices')
      .select('balance_cents, invoice_number')
      .eq('org_id', input.orgId)
      .eq('id', app.invoice_id)
      .maybeSingle();
    if (!inv) throw new PostingError(`Invoice ${app.invoice_id} not found`);
    if (app.amount_cents > Number(inv.balance_cents)) {
      throw new PostingError(`Application ${app.amount_cents} exceeds balance ${inv.balance_cents} on ${inv.invoice_number}`);
    }
  }

  const rail = input.rail ?? methodToRail(input.method);
  const cash = input.cashAccountId
    ? await getAccountRef(db, input.orgId, input.cashAccountId)
    : await resolveCashSide(db, input.orgId, rail, input.locationId);
  const ar = await resolveRole(db, input.orgId, 'AR_CONTROL');

  const cashLine = {
    account_id: cash.id,
    ...debitCreditFor(cash.account_type, cashSideEffect(cash, 'receive'), input.amountCents, cash.account_sub_type),
    location_id: input.locationId,
    memo: 'Customer payment',
  };
  const arLine = {
    account_id: ar.id,
    ...debitCreditFor(ar.account_type, 'decrease', input.amountCents, ar.account_sub_type),
    location_id: input.locationId,
    memo: 'Clear receivable',
  };

  const je = await postJournalEntry(db, {
    org_id: input.orgId,
    location_id: input.locationId,
    entry_date: input.paymentDate,
    memo: `Customer payment ${input.referenceNumber ?? ''}`.trim(),
    source_module: 'AR',
    created_by: null,
    lines: [cashLine, arLine],
  });
  if (!je.success || !je.entry_id) throw new PostingError(je.error ?? 'Failed to post customer payment');

  const { data: payment, error: payErr } = await db
    .from('customer_payments')
    .insert({
      org_id: input.orgId,
      customer_id: input.customerId,
      payment_date: input.paymentDate,
      amount_cents: input.amountCents,
      payment_method: input.method ?? null,
      reference_number: input.referenceNumber ?? null,
      bank_account_id: input.bankAccountId ?? null,
      gl_entry_id: je.entry_id,
    })
    .select('id')
    .single();
  if (payErr || !payment) throw new PostingError(payErr?.message ?? 'Failed to record payment');

  for (const app of input.applications) {
    await db.from('payment_applications').insert({
      org_id: input.orgId,
      payment_id: payment.id,
      invoice_id: app.invoice_id,
      amount_cents: app.amount_cents,
    });
    const { data: inv } = await db
      .from('invoices')
      .select('amount_paid_cents, total_cents')
      .eq('id', app.invoice_id)
      .single();
    if (inv) {
      const newPaid = Number(inv.amount_paid_cents) + app.amount_cents;
      const status = newPaid >= Number(inv.total_cents) ? 'PAID' : 'PARTIALLY_PAID';
      await db.from('invoices').update({ amount_paid_cents: newPaid, status }).eq('id', app.invoice_id);
    }
  }

  return { payment_id: payment.id as string, gl_entry_id: je.entry_id, applications_count: input.applications.length };
}
