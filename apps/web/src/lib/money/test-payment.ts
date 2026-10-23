/**
 * "$1 test payment" (FPB-payments-fees §17.4) — prove a company's money path end to end:
 * a $1.00 invoice on that company, paid through the real hosted pay page into the
 * company's own Stripe account, marked PAID by the webhook and posted to the GL. Then
 * clean up:
 *   - not paid yet → CANCEL: the invoice is voided (its issuance entry reversed);
 *   - paid         → REFUND: Stripe refunds the charge (transfer reversed, platform fee
 *                    returned) and BOTH GL entries (issuance + collection) are voided, so
 *                    the company's books return to exactly where they were. Stripe's own
 *                    processing cost is borne by the platform, never the company.
 * Only invoices this helper created (public.payment_test_runs) can be refunded here —
 * general customer refunds are out of scope. Every step is audited.
 *
 * Service role only (invoices, GL, customer_payments and payment_test_runs are
 * SELECT-only for members); callers authorize first (settings_system:edit).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createInvoice } from '@/lib/invoices/create-invoice';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import { assertInvoiceVoidable } from '@/lib/invoices/void-invoice';
import { voidJournalEntry } from '@/lib/services/gl-posting';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { resolveCollectionAccount, writeAudit } from '@/lib/money/payment-accounts';
import { loadInvoicePaymentTerms } from '@/lib/money/payment-terms';
import { stripeCanCharge } from '@/lib/money/payments-mode';
import { refundDestinationPaymentIntent } from '@/lib/money/providers/stripe';
import type { ProviderEnvironment } from '@/lib/money/providers/types';

export const TEST_PAYMENT_CENTS = 100;
export const TEST_CUSTOMER_NAME = 'Payment test (internal)';

export class TestPaymentError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
    this.name = 'TestPaymentError';
  }
}

export type TestRunState = 'awaiting_payment' | 'processing' | 'paid' | 'cancelled' | 'refunded';

export interface TestRun {
  id: string;
  locationId: string;
  environment: ProviderEnvironment;
  amountCents: number;
  state: TestRunState;
  invoiceId: string | null;
  invoiceNumber: string | null;
  payPath: string | null;
  createdBy: string;
  createdAt: string;
  closedAt: string | null;
}

interface RunRow {
  id: string; org_id: string; location_id: string; invoice_id: string | null; connection_id: string | null;
  environment: ProviderEnvironment; amount_cents: number; status: 'CREATED' | 'CANCELLED' | 'REFUNDED';
  payment_intent_id: string | null; refund_id: string | null; created_by: string; created_at: string; closed_at: string | null;
}

interface InvoiceRow {
  id: string; org_id: string; location_id: string; customer_id: string; job_id: string | null; status: string;
  invoice_number: string; total_cents: number; amount_paid_cents: number; gl_entry_id: string | null; public_token: string;
  payment_methods_allowed: string[] | null; card_surcharge_enabled: boolean | null; ach_surcharge_enabled: boolean | null;
}

const INVOICE_COLS = 'id, org_id, location_id, customer_id, job_id, status, invoice_number, total_cents, amount_paid_cents, gl_entry_id, public_token, payment_methods_allowed, card_surcharge_enabled, ach_surcharge_enabled';

/** Derive a run's state from the run row + its invoice. Pure. */
export function testRunState(run: Pick<RunRow, 'status'>, inv: Pick<InvoiceRow, 'status' | 'amount_paid_cents' | 'total_cents'> | null, processing = false): TestRunState {
  if (run.status === 'CANCELLED') return 'cancelled';
  if (run.status === 'REFUNDED') return 'refunded';
  if (inv && (inv.status === 'PAID' || (inv.total_cents > 0 && inv.amount_paid_cents >= inv.total_cents))) return 'paid';
  if (processing) return 'processing';
  return 'awaiting_payment';
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function findOrCreateTestCustomer(db: SupabaseClient, orgId: string, locationId: string): Promise<string> {
  const { data: found } = await db
    .schema('core').from('customers')
    .select('id')
    .eq('org_id', orgId)
    .eq('name', TEST_CUSTOMER_NAME)
    .eq('location_id', locationId)
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (found) return found.id;
  const { data, error } = await serviceWriter(db)
    .schema('core').from('customers')
    .insert({ org_id: orgId, name: TEST_CUSTOMER_NAME, display_name: TEST_CUSTOMER_NAME, location_id: locationId, payment_terms_days: 0, is_active: true })
    .select('id')
    .single<{ id: string }>();
  if (error || !data) throw new TestPaymentError(`Could not set up the test customer: ${error?.message ?? 'unknown error'}`, 500);
  return data.id;
}

/** An approved, active income account usable by this company (lowest number first). */
async function pickIncomeAccount(db: SupabaseClient, orgId: string, locationId: string): Promise<string> {
  const { data, error } = await db
    .from('accounts')
    .select('id, account_number, company_location_id, approval_status')
    .eq('org_id', orgId)
    .eq('account_type', 'REVENUE')
    .eq('is_active', true)
    .order('account_number', { ascending: true });
  if (error) throw new TestPaymentError(error.message, 500);
  const rows = (data ?? []) as Array<{ id: string; company_location_id: string | null; approval_status: string | null }>;
  const ok = rows.find((r) => (r.approval_status ?? 'APPROVED') === 'APPROVED' && (r.company_location_id === null || r.company_location_id === locationId));
  if (!ok) throw new TestPaymentError('This company has no income account in its chart of accounts, so a test invoice cannot be created.');
  return ok.id;
}

async function loadRun(db: SupabaseClient, orgId: string, runId: string): Promise<RunRow> {
  const { data, error } = await db.from('payment_test_runs').select('*').eq('org_id', orgId).eq('id', runId).maybeSingle<RunRow>();
  if (error) throw new TestPaymentError(error.message, 500);
  if (!data) throw new TestPaymentError('That test payment was not found.', 404);
  return data;
}

async function loadInvoice(db: SupabaseClient, orgId: string, invoiceId: string | null): Promise<InvoiceRow | null> {
  if (!invoiceId) return null;
  const { data } = await db.from('invoices').select(INVOICE_COLS).eq('org_id', orgId).eq('id', invoiceId).maybeSingle<InvoiceRow>();
  return data ?? null;
}

/** Create the $1 invoice for a company and return its pay link path (/pay/<token>). */
export async function createTestPayment(
  adminDb: SupabaseClient,
  args: { orgId: string; locationId: string; userId: string },
): Promise<{ run: TestRun; reused: boolean }> {
  if (!stripeCanCharge()) throw new TestPaymentError('Stripe is not set up on the server yet, so a test payment cannot run.');
  const pick = await resolveCollectionAccount(adminDb, args.orgId, args.locationId);
  if (!pick.connection || !pick.environment) throw new TestPaymentError('Connect this company to Stripe first.');
  if (!pick.ready) throw new TestPaymentError('Stripe has paused payments for this company. Finish its Stripe setup first.');

  // One open test per company: hand back the existing link instead of stacking invoices.
  const { data: open } = await adminDb
    .from('payment_test_runs').select('*')
    .eq('org_id', args.orgId).eq('location_id', args.locationId).eq('status', 'CREATED')
    .order('created_at', { ascending: false }).limit(1).maybeSingle<RunRow>();
  if (open) {
    const inv = await loadInvoice(adminDb, args.orgId, open.invoice_id);
    if (inv && testRunState(open, inv) === 'awaiting_payment') return { run: toRun(open, inv), reused: true };
  }

  const customerId = await findOrCreateTestCustomer(adminDb, args.orgId, args.locationId);
  const accountId = await pickIncomeAccount(adminDb, args.orgId, args.locationId);
  const date = today();
  const outcome = await createInvoice(adminDb, {
    orgId: args.orgId,
    actor: args.userId,
    input: {
      location_id: args.locationId,
      customer_id: customerId,
      invoice_date: date,
      due_date: date,
      memo: 'Payment test from Settings → Payments. Refund or cancel it there.',
      post_to_gl: true,
      tax_cents: 0,
      auto_tax: false,
      retainage_cents: 0,
      lines: [{ description: 'Payment test', account_id: accountId, quantity: 1, unit_price_cents: TEST_PAYMENT_CENTS }],
    },
  });
  if (!outcome.ok) throw new TestPaymentError(`Could not create the test invoice: ${outcome.error}`, outcome.status);
  const invoiceId = outcome.result.invoice_id;
  if (!outcome.result.posted) {
    await serviceWriter(adminDb).from('invoices').update({ status: 'VOIDED' }).eq('org_id', args.orgId).eq('id', invoiceId);
    throw new TestPaymentError('The test invoice could not be posted to the books (check that this month is open), so it was voided.');
  }

  const inv = await loadInvoice(adminDb, args.orgId, invoiceId);
  if (inv) {
    const terms = await loadInvoicePaymentTerms(adminDb, inv);
    if (terms.online.length === 0) {
      await voidInvoiceAndIssuance(adminDb, args.orgId, inv, args.userId, 'Payment test cancelled: no online method is on');
      throw new TestPaymentError('Turn on card or bank transfer for this company first — the test pays online.');
    }
  }

  const { data: run, error } = await serviceWriter(adminDb)
    .from('payment_test_runs')
    .insert({
      org_id: args.orgId,
      location_id: args.locationId,
      invoice_id: invoiceId,
      connection_id: pick.connection.id,
      environment: pick.environment,
      amount_cents: TEST_PAYMENT_CENTS,
      status: 'CREATED',
      created_by: args.userId,
    })
    .select('*')
    .single<RunRow>();
  if (error || !run) throw new TestPaymentError(`Could not record the test payment: ${error?.message ?? 'unknown error'}`, 500);
  await writeAudit(adminDb, { orgId: args.orgId, table: 'payment_test_runs', recordId: run.id, field: 'status', oldValue: null, newValue: `CREATED (${pick.environment})`, userId: args.userId, action: 'INSERT' });
  return { run: toRun(run, inv), reused: false };
}

function toRun(r: RunRow, inv: InvoiceRow | null, processing = false): TestRun {
  return {
    id: r.id,
    locationId: r.location_id,
    environment: r.environment,
    amountCents: Number(r.amount_cents),
    state: testRunState(r, inv, processing),
    invoiceId: r.invoice_id,
    invoiceNumber: inv?.invoice_number ?? null,
    payPath: inv && r.status === 'CREATED' ? `/pay/${inv.public_token}` : null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    closedAt: r.closed_at,
  };
}

/** Recent test payments (newest first), with their live state. */
export async function listTestRuns(db: SupabaseClient, orgId: string, limit = 20): Promise<TestRun[]> {
  const { data, error } = await db.from('payment_test_runs').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  const runs = (data ?? []) as RunRow[];
  const ids = runs.map((r) => r.invoice_id).filter((x): x is string => !!x);
  const invById = new Map<string, InvoiceRow>();
  const processing = new Set<string>();
  if (ids.length > 0) {
    const { data: invs } = await db.from('invoices').select(INVOICE_COLS).eq('org_id', orgId).in('id', ids);
    for (const inv of (invs ?? []) as InvoiceRow[]) invById.set(inv.id, inv);
    const { data: evs } = await db.from('invoice_events').select('invoice_id').eq('org_id', orgId).eq('event_type', 'PAY_PROCESSING').in('invoice_id', ids);
    for (const e of (evs ?? []) as Array<{ invoice_id: string }>) processing.add(e.invoice_id);
  }
  return runs.map((r) => toRun(r, r.invoice_id ? invById.get(r.invoice_id) ?? null : null, !!r.invoice_id && processing.has(r.invoice_id)));
}

async function periodHardClosed(db: SupabaseClient, orgId: string, entryId: string | null): Promise<boolean> {
  if (!entryId) return false;
  const { data: e } = await db.from('gl_entries').select('fiscal_period_id, status').eq('org_id', orgId).eq('id', entryId).maybeSingle<{ fiscal_period_id: string | null; status: string }>();
  if (!e?.fiscal_period_id) return false;
  const { data: p } = await db.from('fiscal_periods').select('status').eq('id', e.fiscal_period_id).maybeSingle<{ status: string }>();
  return p?.status === 'HARD_CLOSE';
}

async function voidInvoiceAndIssuance(db: SupabaseClient, orgId: string, inv: InvoiceRow, userId: string, reason: string): Promise<void> {
  if (inv.gl_entry_id) {
    const rev = await voidJournalEntry(db, orgId, inv.gl_entry_id, userId, `Invoice ${inv.invoice_number} voided: ${reason}`);
    if (!rev.success && !/status VOIDED/.test(rev.error ?? '')) throw new TestPaymentError(`Could not reverse the test invoice's journal entry: ${rev.error}`);
  }
  const { error } = await serviceWriter(db).from('invoices').update({ status: 'VOIDED', updated_at: new Date().toISOString() }).eq('org_id', orgId).eq('id', inv.id).neq('status', 'VOIDED');
  if (error) throw new TestPaymentError(error.message, 500);
  await recordInvoiceEvent(db, { orgId, invoiceId: inv.id, type: 'VOIDED', actor: userId, meta: { reason, gl_entry_id: inv.gl_entry_id, reversed: !!inv.gl_entry_id, payment_test: true } });
  await writeAudit(db, { orgId, table: 'invoices', recordId: inv.id, field: 'status', oldValue: inv.status, newValue: 'VOIDED', userId });
}

/** Cancel an unpaid test payment: void its invoice (issuance reversed). */
export async function cancelTestPayment(adminDb: SupabaseClient, args: { orgId: string; runId: string; userId: string }): Promise<TestRun> {
  const run = await loadRun(adminDb, args.orgId, args.runId);
  if (run.status !== 'CREATED') throw new TestPaymentError('This test payment is already closed.');
  const inv = await loadInvoice(adminDb, args.orgId, run.invoice_id);
  if (inv) {
    const voidable = assertInvoiceVoidable({ status: inv.status, amountPaidCents: Number(inv.amount_paid_cents ?? 0) });
    if (!voidable.ok && !voidable.idempotent) throw new TestPaymentError('This test payment has been paid — refund it instead.');
    if (voidable.ok) await voidInvoiceAndIssuance(adminDb, args.orgId, inv, args.userId, 'Payment test cancelled');
  }
  const closed = await closeRun(adminDb, run, 'CANCELLED', args.userId, {});
  return toRun(closed, inv ? { ...inv, status: 'VOIDED' } : null);
}

async function closeRun(db: SupabaseClient, run: RunRow, status: 'CANCELLED' | 'REFUNDED', userId: string, extra: Partial<RunRow>): Promise<RunRow> {
  const { data, error } = await serviceWriter(db)
    .from('payment_test_runs')
    .update({ status, closed_by: userId, closed_at: new Date().toISOString(), ...extra })
    .eq('org_id', run.org_id).eq('id', run.id).eq('status', 'CREATED')
    .select('*')
    .single<RunRow>();
  if (error || !data) throw new TestPaymentError('This test payment was closed by someone else just now.');
  await writeAudit(db, { orgId: run.org_id, table: 'payment_test_runs', recordId: run.id, field: 'status', oldValue: 'CREATED', newValue: status, userId });
  return data;
}

/**
 * Refund a PAID test payment and take it back out of the books. Refused BEFORE any money
 * moves if the payment is still processing or either journal entry is in a hard-closed
 * period (then a person posts a reversing entry instead).
 */
export async function refundTestPayment(
  adminDb: SupabaseClient,
  args: { orgId: string; runId: string; userId: string },
  deps: { refund?: typeof refundDestinationPaymentIntent } = {},
): Promise<TestRun> {
  const refund = deps.refund ?? refundDestinationPaymentIntent;
  const run = await loadRun(adminDb, args.orgId, args.runId);
  if (run.status !== 'CREATED') throw new TestPaymentError('This test payment is already closed.');
  const inv = await loadInvoice(adminDb, args.orgId, run.invoice_id);
  if (!inv || testRunState(run, inv) !== 'paid') throw new TestPaymentError('This test payment has not been paid yet — cancel it instead.');

  // The Stripe payment behind it (customer_payments.reference_number = the PaymentIntent id).
  const { data: apps } = await adminDb.from('payment_applications').select('payment_id').eq('org_id', args.orgId).eq('invoice_id', inv.id);
  const paymentIds = ((apps ?? []) as Array<{ payment_id: string }>).map((a) => a.payment_id);
  const { data: pays } = paymentIds.length
    ? await adminDb.from('customer_payments').select('id, reference_number, gl_entry_id, settlement_status').eq('org_id', args.orgId).in('id', paymentIds)
    : { data: [] as unknown[] };
  const stripePays = ((pays ?? []) as Array<{ id: string; reference_number: string | null; gl_entry_id: string | null; settlement_status: string }>)
    .filter((p) => (p.reference_number ?? '').startsWith('pi_'));
  if (stripePays.length !== 1) throw new TestPaymentError('This test was not paid online through Stripe, so it cannot be refunded here.');
  const pay = stripePays[0];
  const pi = pay.reference_number as string;

  if ((await periodHardClosed(adminDb, args.orgId, inv.gl_entry_id)) || (await periodHardClosed(adminDb, args.orgId, pay.gl_entry_id))) {
    throw new TestPaymentError('The month this test was booked in is closed. Refund it from Stripe and post a reversing entry instead.');
  }

  // 1. Money first: if Stripe refuses, nothing in the books changes.
  let refundId: string;
  try {
    refundId = (await refund(pi, `payment-test-refund:${pi}`)).id;
  } catch (e) {
    throw new TestPaymentError(`Stripe did not refund the payment: ${e instanceof Error ? e.message : 'unknown error'}`, 502);
  }

  // 2. Books: void the collection and the issuance → the company nets to zero.
  if (pay.gl_entry_id) {
    const r = await voidJournalEntry(adminDb, args.orgId, pay.gl_entry_id, args.userId, `Payment test ${inv.invoice_number} refunded (${refundId})`);
    if (!r.success && !/status VOIDED/.test(r.error ?? '')) throw new TestPaymentError(`Refunded in Stripe, but the payment's journal entry could not be reversed: ${r.error}`, 500);
  }
  await serviceWriter(adminDb).from('customer_payments').update({ settlement_status: 'REFUNDED' }).eq('org_id', args.orgId).eq('id', pay.id);
  await recordInvoiceEvent(adminDb, { orgId: args.orgId, invoiceId: inv.id, type: 'REFUNDED', actor: args.userId, meta: { pi, refund_id: refundId, amount_cents: TEST_PAYMENT_CENTS, payment_test: true } });
  await voidInvoiceAndIssuance(adminDb, args.orgId, inv, args.userId, `Payment test refunded (${refundId})`);

  const closed = await closeRun(adminDb, run, 'REFUNDED', args.userId, { payment_intent_id: pi, refund_id: refundId });
  return toRun(closed, { ...inv, status: 'VOIDED' });
}
