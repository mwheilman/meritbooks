/**
 * End-to-end payment chain — the test that would have caught the Session 37
 * blocker, and the one the local PGlite harness deliberately cannot do.
 *
 * Runs against a REAL Supabase branch (real PostgREST, real RLS, real triggers)
 * because the posting code talks through supabase-js. Hand-faking that client
 * would risk passing tests over a broken system, so this suite simply skips
 * unless a branch is wired up:
 *
 *   TEST_SUPABASE_URL=... TEST_SUPABASE_SERVICE_ROLE_KEY=... npm test
 *
 * It never runs against production: the guard below refuses to start if the URL
 * matches the production project ref.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { applyStripePaymentToInvoice, deriveTenantFeeCents } from '@/lib/money/apply-invoice-payment';

const URL = process.env.TEST_SUPABASE_URL;
const KEY = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const PRODUCTION_REF = 'npqeijipggtuduhkejxq';

const enabled = Boolean(URL && KEY);

if (URL?.includes(PRODUCTION_REF)) {
  throw new Error(
    'REFUSING TO RUN: TEST_SUPABASE_URL points at the production project. ' +
      'Integration tests must target an ephemeral branch.',
  );
}

// A fixed fixture namespace so a failed run leaves identifiable rows behind.
const ORG = '00000000-0000-4000-8000-00000000e2e1';
const LOC = '00000000-0000-4000-8000-00000000e2e2';
const CUST = '00000000-0000-4000-8000-00000000e2e3';
const INV = '00000000-0000-4000-8000-00000000e2e4';

const BASE = 15_000_000; // $150,000.00
const ACH_APP_FEE = 150_000; // 1%

let db: SupabaseClient;

describe.skipIf(!enabled)('payment chain against a real Supabase branch', () => {
  beforeAll(async () => {
    db = createClient(URL!, KEY!, { auth: { persistSession: false } });
  });

  afterAll(async () => {
    if (!enabled) return;
    // Fixture teardown is best-effort; the branch itself is deleted by the runner.
    await db.from('payment_applications').delete().eq('org_id', ORG);
    await db.from('customer_payments').delete().eq('org_id', ORG);
    await db.from('invoices').delete().eq('org_id', ORG);
  });

  it('derives the ACH fee the ledger will actually book', () => {
    expect(deriveTenantFeeCents(BASE, BASE, ACH_APP_FEE)).toBe(150_000);
  });

  it('flips the invoice to PAID and posts a balanced journal entry', async () => {
    const piId = `pi_test_${Date.now()}`;

    const result = await applyStripePaymentToInvoice(db, {
      orgId: ORG,
      invoiceId: INV,
      locationId: LOC,
      customerId: CUST,
      baseCents: BASE,
      amountCents: BASE,
      appFeeCents: ACH_APP_FEE,
      method: 'ACH',
      piId,
    });

    expect(result.applied).toBe(true);

    // 1. Invoice reached PAID with the full amount applied.
    const { data: inv } = await db
      .from('invoices')
      .select('status, amount_paid_cents, total_cents')
      .eq('id', INV)
      .single();
    expect(inv?.status).toBe('PAID');
    expect(Number(inv?.amount_paid_cents)).toBe(BASE);

    // 2. A journal entry exists, linked to this PaymentIntent.
    const { data: payment } = await db
      .from('customer_payments')
      .select('id, gl_entry_id')
      .eq('reference_number', piId)
      .single();
    expect(payment?.gl_entry_id).toBeTruthy();

    // 3. That entry balances, in exact cents.
    const { data: lines } = await db
      .from('gl_entry_lines')
      .select('debit_cents, credit_cents')
      .eq('gl_entry_id', payment!.gl_entry_id);

    const debits = (lines ?? []).reduce((s, l) => s + Number(l.debit_cents), 0);
    const credits = (lines ?? []).reduce((s, l) => s + Number(l.credit_cents), 0);
    expect(debits).toBe(credits);
    expect(credits).toBe(BASE); // A/R relieved for the gross
  });

  it('is idempotent — replaying the same PaymentIntent posts nothing further', async () => {
    const piId = `pi_test_replay_${Date.now()}`;
    const args = {
      orgId: ORG, invoiceId: INV, locationId: LOC, customerId: CUST,
      baseCents: 100_000, amountCents: 100_000, appFeeCents: 1_000,
      method: 'ACH' as const, piId,
    };

    const first = await applyStripePaymentToInvoice(db, args);
    expect(first.applied).toBe(true);

    const second = await applyStripePaymentToInvoice(db, args);
    expect(second.applied).toBe(false);

    const { data: payments } = await db
      .from('customer_payments')
      .select('id')
      .eq('reference_number', piId);
    expect(payments).toHaveLength(1);
  });

  it('leaves the trial balance at zero for the org', async () => {
    const { data: lines } = await db
      .from('gl_entry_lines')
      .select('debit_cents, credit_cents')
      .eq('org_id', ORG);

    const debits = (lines ?? []).reduce((s, l) => s + Number(l.debit_cents), 0);
    const credits = (lines ?? []).reduce((s, l) => s + Number(l.credit_cents), 0);
    expect(debits).toBe(credits);
  });
});
