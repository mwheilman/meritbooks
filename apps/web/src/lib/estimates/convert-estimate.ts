/**
 * Convert an estimate to a REAL invoice — by CALLING the shared invoice-create
 * core, never by re-implementing invoice/GL logic.
 *
 * The estimate itself never posts (it is a non-posting document). Conversion
 * hands the estimate's lines to `createInvoice`, which mints the invoice number,
 * inserts the header + lines, and posts the rev-rec-aware AR journal entry through
 * the unchanged gl-posting path. Only that invoice posts.
 *
 * DOUBLE-CONVERT IS IMPOSSIBLE. Before creating anything we CLAIM the estimate
 * with a conditional UPDATE (`status → CONVERTED` only while it is not already
 * CONVERTED and has no invoice stamped). The WHERE clause is the atomic guard: of
 * two concurrent requests exactly one update matches a row; the loser sees 0 rows
 * and stops before an invoice is ever created (so there is no orphaned GL post to
 * unwind). Only after the invoice is created do we stamp `converted_invoice_id`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createInvoice } from '@/lib/invoices/create-invoice';
import { canConvertEstimate } from './estimate-logic';

export type ConvertOutcome =
  | { ok: true; invoiceId: string; invoiceNumber: string; totalCents: number }
  | { ok: false; status: number; error: string };

interface EstimateRow {
  id: string;
  status: string;
  converted_invoice_id: string | null;
  location_id: string;
  customer_id: string;
  job_id: string | null;
  tax_cents: number | null;
}

interface EstimateLineRow {
  line_number: number | null;
  description: string;
  quantity: number | null;
  unit_price_cents: number | null;
  revenue_account_id: string | null;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function convertEstimateToInvoice(
  supabase: SupabaseClient,
  args: { orgId: string; actor: string | null; estimateId: string },
): Promise<ConvertOutcome> {
  const { orgId, actor, estimateId } = args;

  // 1. Load the estimate (explicit org filter — defense in depth on top of RLS).
  const { data: est } = await supabase
    .from('estimates')
    .select('id, status, converted_invoice_id, location_id, customer_id, job_id, tax_cents')
    .eq('org_id', orgId)
    .eq('id', estimateId)
    .maybeSingle();

  if (!est) return { ok: false, status: 404, error: 'Estimate not found' };
  const estimate = est as EstimateRow;

  // Fast, user-friendly pre-check (the atomic claim below is the real guarantee).
  const guard = canConvertEstimate(estimate.status, estimate.converted_invoice_id);
  if (!guard.ok) return { ok: false, status: 409, error: guard.reason };

  // 2. Load lines; a converted invoice must carry a revenue account per line.
  const { data: lineRows } = await supabase
    .from('estimate_lines')
    .select('line_number, description, quantity, unit_price_cents, revenue_account_id')
    .eq('estimate_id', estimateId)
    .order('line_number', { ascending: true });

  const lines = (lineRows ?? []) as EstimateLineRow[];
  if (lines.length === 0) {
    return { ok: false, status: 422, error: 'Estimate has no line items to convert.' };
  }
  if (lines.some((l) => !l.revenue_account_id)) {
    return {
      ok: false,
      status: 422,
      error: 'Every line needs a revenue account before this estimate can be converted.',
    };
  }

  // 3. ATOMIC CLAIM. Flip status → CONVERTED only if it is still convertible.
  //    The WHERE clause (status != CONVERTED AND converted_invoice_id IS NULL)
  //    makes this the single point of serialization: the loser of a race matches
  //    0 rows and returns before any invoice is created.
  const { data: claimed, error: claimErr } = await supabase
    .from('estimates')
    .update({ status: 'CONVERTED', updated_at: new Date().toISOString() })
    .eq('id', estimateId)
    .eq('org_id', orgId)
    .neq('status', 'CONVERTED')
    .is('converted_invoice_id', null)
    .select('id');

  if (claimErr) return { ok: false, status: 500, error: claimErr.message };
  if (!claimed || claimed.length === 0) {
    return { ok: false, status: 409, error: 'This estimate has already been converted.' };
  }

  const revertClaim = async () => {
    await supabase
      .from('estimates')
      .update({ status: estimate.status, updated_at: new Date().toISOString() })
      .eq('id', estimateId)
      .eq('org_id', orgId)
      .is('converted_invoice_id', null);
  };

  // 4. Create the invoice via the SHARED path (numbering + GL posting live there).
  const today = new Date();
  const due = new Date();
  due.setDate(due.getDate() + 30);

  const outcome = await createInvoice(supabase, {
    orgId,
    actor,
    input: {
      location_id: estimate.location_id,
      customer_id: estimate.customer_id,
      job_id: estimate.job_id ?? null,
      invoice_date: isoDate(today),
      due_date: isoDate(due),
      memo: 'Converted from estimate',
      tax_cents: Number(estimate.tax_cents ?? 0),
      auto_tax: false,
      post_to_gl: true,
      lines: lines.map((l) => ({
        description: l.description,
        account_id: l.revenue_account_id as string,
        quantity: Number(l.quantity ?? 1),
        unit_price_cents: Number(l.unit_price_cents ?? 0),
      })),
    },
  });

  if (!outcome.ok) {
    // Invoice creation failed — release the claim so the estimate stays convertible.
    await revertClaim();
    return { ok: false, status: outcome.status, error: outcome.error };
  }

  // 5. Stamp the resulting invoice id (completes the one-way conversion link).
  await supabase
    .from('estimates')
    .update({
      converted_invoice_id: outcome.result.invoice_id,
      converted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', estimateId)
    .eq('org_id', orgId);

  return {
    ok: true,
    invoiceId: outcome.result.invoice_id,
    invoiceNumber: outcome.result.invoice_number,
    totalCents: outcome.result.total_cents,
  };
}
