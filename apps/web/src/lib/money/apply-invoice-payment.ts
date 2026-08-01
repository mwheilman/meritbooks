import type { SupabaseClient } from '@supabase/supabase-js';
import { postArCollection } from '@/lib/money/posting/ar-posting';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';

/**
 * Apply a succeeded Stripe PaymentIntent to its invoice: post the AR collection
 * GL entry, record the customer payment + application, reduce the invoice
 * balance, and log lifecycle events. Idempotent via reference_number = PI id.
 *
 * GL fee = the amount the tenant did NOT net on the invoice base:
 *   ACH:            fee = 1% (tenant bears it)
 *   card pass-thru: fee = 0  (the surcharge covered the processing)
 *   card absorbed:  fee = 3% (tenant bears it)
 */
/**
 * The fee the tenant actually bore on the invoice base — i.e. the amount they
 * did NOT net. Pure so it can be asserted in isolation.
 *
 *   feeCents = base - (amountCharged - applicationFee)
 *
 *   ACH 1%:          base 15000000, charged 15000000, AF 150000 -> 150000
 *   card pass-thru:  base 15000000, charged 15450000, AF 450000 -> 0
 *   card absorbed:   base 15000000, charged 15000000, AF 450000 -> 450000
 */
export function deriveTenantFeeCents(
  baseCents: number,
  amountCents: number,
  appFeeCents: number,
): number {
  const tenantNet = amountCents - appFeeCents;
  return Math.max(0, baseCents - tenantNet);
}

export async function applyStripePaymentToInvoice(
  db: SupabaseClient,
  args: {
    orgId: string; invoiceId: string; locationId: string; customerId: string;
    baseCents: number; amountCents: number; appFeeCents: number;
    method: 'CARD' | 'ACH'; piId: string;
  },
): Promise<{ applied: boolean }> {
  // Steady-state idempotency: once the customer_payments anchor exists for this
  // PaymentIntent, the payment is fully applied — nothing left to do.
  const { data: existing } = await db
    .from('customer_payments').select('id').eq('org_id', args.orgId).eq('reference_number', args.piId).maybeSingle();
  if (existing) return { applied: false };

  const feeCents = deriveTenantFeeCents(args.baseCents, args.amountCents, args.appFeeCents);
  const today = new Date().toISOString().slice(0, 10);

  // 1. AR-collection GL post — idempotent by source_ref. The processor id (pi_…)
  //    is a globally-unique, stable key, so if a prior delivery of this event
  //    already posted the collection (but failed further down before the payment
  //    anchor was written), we REUSE that entry instead of posting a second one.
  //    Without this, a retry after "GL posted, anchor not yet written" would
  //    double-post the collection and double-relieve A/R.
  let glEntryId: string;
  const { data: priorGl } = await db.from('gl_entries')
    .select('id')
    .eq('org_id', args.orgId)
    .eq('source_ref', args.piId)
    .eq('entry_type', 'AR_COLLECTION')
    .eq('status', 'POSTED')
    .maybeSingle();
  if (priorGl) {
    glEntryId = (priorGl as { id: string }).id;
  } else {
    const post = await postArCollection(db, {
      orgId: args.orgId, locationId: args.locationId, entryDate: today,
      grossCents: args.baseCents, feeCents, createdBy: null, sourceId: args.piId,
    });
    // A book of record must never show a PAID invoice with no journal entry
    // behind it. If the GL post failed, abort before recording the payment or
    // flipping status — the caller returns 500 and Stripe retries the event.
    if (!post.success || !post.entry_id) {
      throw new Error(
        `AR collection GL post failed for ${args.piId} (invoice ${args.invoiceId}): ${post.error ?? 'unknown error'}`,
      );
    }
    glEntryId = post.entry_id;
  }

  // 2. customer_payments anchor — the idempotency key (reference_number = pi id).
  //    Fail CLOSED if this write errors: a swallowed error here would leave the
  //    GL posted and the invoice flipped to PAID with no A/R sub-ledger record
  //    and no dedupe anchor. Throwing releases the webhook's event claim so
  //    Stripe retries; the retry reuses the GL entry above (no double post).
  const { data: pay, error: payErr } = await db.from('customer_payments').insert({
    org_id: args.orgId,
    customer_id: args.customerId,
    payment_date: today,
    amount_cents: args.baseCents,
    payment_method: args.method === 'ACH' ? 'ACH' : 'CREDIT_CARD',
    reference_number: args.piId,
    gl_entry_id: glEntryId,
  }).select('id').single();
  if (payErr || !pay) {
    throw new Error(
      `customer_payments insert failed for ${args.piId} (invoice ${args.invoiceId}): ${payErr?.message ?? 'no row returned'}`,
    );
  }
  const paymentId = (pay as { id: string }).id;

  // 3. payment_applications — idempotent on (payment_id, invoice_id). Only when
  //    we NEWLY create the application do we advance the invoice, so the balance
  //    is never double-decremented on a resume.
  const { data: priorApp } = await db.from('payment_applications')
    .select('id').eq('payment_id', paymentId).eq('invoice_id', args.invoiceId).maybeSingle();
  const wasNewApplication = !priorApp;
  if (wasNewApplication) {
    const { error: appErr } = await db.from('payment_applications').insert({
      org_id: args.orgId, payment_id: paymentId,
      invoice_id: args.invoiceId, amount_cents: args.baseCents,
    });
    if (appErr) {
      throw new Error(
        `payment_applications insert failed for ${args.piId} (invoice ${args.invoiceId}): ${appErr.message}`,
      );
    }
  }

  // 4. Advance the invoice. amount_paid_cents is an incrementing balance (it is
  //    ALSO written by bulk import and manual payments, so it must never be
  //    recomputed from applications). Increment only on a new application so a
  //    retry can't over-pay. balance_cents is a generated column.
  let fullyPaid = false;
  if (wasNewApplication) {
    const { data: invRow } = await db.from('invoices')
      .select('amount_paid_cents, total_cents').eq('id', args.invoiceId).single();
    const prevPaid = Number((invRow as { amount_paid_cents: number } | null)?.amount_paid_cents ?? 0);
    const total = Number((invRow as { total_cents: number } | null)?.total_cents ?? 0);
    const newPaid = prevPaid + args.baseCents;
    fullyPaid = newPaid >= total;
    await db.from('invoices').update({
      amount_paid_cents: newPaid,
      status: fullyPaid ? 'PAID' : 'PARTIALLY_PAID',
    }).eq('id', args.invoiceId);
  }

  await recordInvoiceEvent(db, { orgId: args.orgId, invoiceId: args.invoiceId, type: 'PAY_SUCCEEDED', actor: 'customer', meta: { pi: args.piId, amount_cents: args.amountCents, method: args.method } });
  await recordInvoiceEvent(db, { orgId: args.orgId, invoiceId: args.invoiceId, type: 'PAYMENT_APPLIED', actor: 'system', meta: { applied_cents: args.baseCents, gl_entry_id: glEntryId } });
  if (fullyPaid) await recordInvoiceEvent(db, { orgId: args.orgId, invoiceId: args.invoiceId, type: 'MARKED_PAID', actor: 'system', meta: {} });

  return { applied: true };
}
