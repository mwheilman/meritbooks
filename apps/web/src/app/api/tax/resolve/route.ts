export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { resolveInvoiceTax } from '@/lib/tax/resolve-invoice-tax';

/**
 * Live sales-tax preview for the invoice-create form (GATE 11d). Given a customer +
 * date + taxable line amounts, returns the resolved rate/jurisdiction and the tax
 * that would accrue — so the user sees the computed tax BEFORE saving. Read-only,
 * RLS-scoped, degrade-safe (no configured rate → tax 0). Requires invoices:view.
 */

const schema = z.object({
  customer_id: z.string().uuid().nullable().optional(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  line_amounts_cents: z.array(z.number().int()).default([]),
  ship_to: z.record(z.unknown()).nullable().optional(),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;

  const raw = await request.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }
  const b = parsed.data;

  const resolved = await resolveInvoiceTax(supabase, {
    orgId: orgId ?? '',
    customerId: b.customer_id ?? null,
    onDate: b.invoice_date,
    lineAmountsCents: b.line_amounts_cents,
    shipTo: b.ship_to ?? null,
  });

  return NextResponse.json({
    taxCents: resolved.taxCents,
    taxableSubtotalCents: resolved.taxableSubtotalCents,
    ratePct: resolved.ratePct,
    jurisdictionLabel: resolved.jurisdictionLabel,
    state: resolved.state,
    exempt: resolved.exempt,
    rateResolved: resolved.rateResolved,
  });
}
