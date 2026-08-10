export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { fetchCoreMap } from '@/lib/stitch-core';
import { computeEstimateTotals, computeLineAmountCents } from '@/lib/estimates/estimate-logic';

/**
 * GET /api/estimates/[id]   — full estimate (header + lines + names + invoice link)
 * PATCH /api/estimates/[id] — edit a NON-CONVERTED estimate's header + lines
 */

// ─── GET: estimate detail ──────────────────────────────────────────────
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: est, error } = await supabase
    .from('estimates')
    .select(
      `id, estimate_number, status, estimate_date, expiration_date,
       subtotal_cents, tax_cents, total_cents, currency, notes,
       customer_id, location_id, job_id, converted_invoice_id, converted_at, created_at`,
    )
    .eq('id', params.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!est) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });

  const { data: lineRows } = await supabase
    .from('estimate_lines')
    .select('id, line_number, description, quantity, unit_price_cents, amount_cents, revenue_account_id')
    .eq('estimate_id', params.id)
    .order('line_number', { ascending: true });

  const lines = (lineRows ?? []) as Array<Record<string, unknown>>;
  const accountIds = [...new Set(lines.map((l) => l.revenue_account_id).filter(Boolean))] as string[];

  const custMap = await fetchCoreMap<{ id: string; name: string; email: string | null }>(
    supabase, 'customers', 'id, name, email', [est.customer_id as string]);
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', [est.location_id as string]);
  const jobMap = await fetchCoreMap<{ id: string; job_number: string; name: string }>(
    supabase, 'jobs', 'id, job_number, name', [est.job_id as string]);

  let acctMap = new Map<string, { id: string; account_number: string; name: string }>();
  if (accountIds.length) {
    const { data: acctRows } = await supabase
      .from('accounts')
      .select('id, account_number, name')
      .in('id', accountIds);
    acctMap = new Map(
      ((acctRows ?? []) as Array<{ id: string; account_number: string; name: string }>).map((a) => [a.id, a]),
    );
  }

  // Resolve the converted invoice's number for a friendly link label.
  let convertedInvoice: { id: string; invoiceNumber: string } | null = null;
  if (est.converted_invoice_id) {
    const { data: inv } = await supabase
      .from('invoices')
      .select('id, invoice_number')
      .eq('id', est.converted_invoice_id)
      .maybeSingle();
    if (inv) convertedInvoice = { id: inv.id as string, invoiceNumber: inv.invoice_number as string };
  }

  const cust = est.customer_id ? custMap.get(est.customer_id as string) ?? null : null;
  const loc = est.location_id ? locMap.get(est.location_id as string) ?? null : null;
  const job = est.job_id ? jobMap.get(est.job_id as string) ?? null : null;

  return NextResponse.json({
    id: est.id,
    estimateNumber: est.estimate_number,
    status: est.status,
    estimateDate: est.estimate_date,
    expirationDate: est.expiration_date,
    subtotalCents: Number(est.subtotal_cents ?? 0),
    taxCents: Number(est.tax_cents ?? 0),
    totalCents: Number(est.total_cents ?? 0),
    currency: est.currency ?? 'USD',
    notes: est.notes,
    convertedInvoiceId: est.converted_invoice_id,
    convertedAt: est.converted_at,
    convertedInvoice,
    customer: cust ? { id: cust.id, name: cust.name, email: cust.email } : null,
    location: loc ? { id: loc.id, name: loc.name, shortCode: loc.short_code } : null,
    job: job ? { id: job.id, jobNumber: job.job_number, name: job.name } : null,
    lines: lines.map((l) => {
      const acct = l.revenue_account_id ? acctMap.get(l.revenue_account_id as string) ?? null : null;
      return {
        id: l.id,
        lineNumber: Number(l.line_number ?? 0),
        description: String(l.description ?? ''),
        quantity: Number(l.quantity ?? 0),
        unitPriceCents: Number(l.unit_price_cents ?? 0),
        amountCents: Number(l.amount_cents ?? 0),
        revenueAccountId: (l.revenue_account_id as string) ?? null,
        account: acct ? { id: acct.id, accountNumber: acct.account_number, name: acct.name } : null,
      };
    }),
  });
}

// ─── PATCH: edit a non-converted estimate ──────────────────────────────
const editSchema = z.object({
  customer_id: z.string().uuid().optional(),
  job_id: z.string().uuid().nullable().optional(),
  estimate_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expiration_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  tax_cents: z.number().int().min(0).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1).max(500),
        revenue_account_id: z.string().uuid('A revenue account is required'),
        quantity: z.number().min(0),
        unit_price_cents: z.number().int(),
      }),
    )
    .min(1, 'At least one line item is required')
    .optional(),
});

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  const parsed = editSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.issues },
      { status: 422 },
    );
  }
  const body = parsed.data;
  const supabase = createAdminSupabase();

  const { data: est } = await supabase
    .from('estimates')
    .select('id, status, converted_invoice_id, tax_cents')
    .eq('org_id', orgId)
    .eq('id', params.id)
    .maybeSingle();
  if (!est) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  if (est.status === 'CONVERTED' || est.converted_invoice_id) {
    return NextResponse.json({ error: 'A converted estimate can no longer be edited.' }, { status: 409 });
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.customer_id !== undefined) update.customer_id = body.customer_id;
  if (body.job_id !== undefined) update.job_id = body.job_id;
  if (body.estimate_date !== undefined) update.estimate_date = body.estimate_date;
  if (body.expiration_date !== undefined) update.expiration_date = body.expiration_date;
  if (body.notes !== undefined) update.notes = body.notes;

  // If lines change (or tax changes), recompute the stored money totals.
  if (body.lines) {
    const taxCents = body.tax_cents ?? Number(est.tax_cents ?? 0);
    const totals = computeEstimateTotals(
      body.lines.map((l) => ({ quantity: l.quantity, unit_price_cents: l.unit_price_cents })),
      taxCents,
    );
    update.subtotal_cents = totals.subtotalCents;
    update.tax_cents = totals.taxCents;
    update.total_cents = totals.totalCents;

    // Replace lines wholesale.
    await supabase.from('estimate_lines').delete().eq('estimate_id', params.id);
    const lineInserts = body.lines.map((l, i) => ({
      org_id: orgId,
      estimate_id: params.id,
      line_number: i + 1,
      description: l.description,
      quantity: l.quantity,
      unit_price_cents: l.unit_price_cents,
      amount_cents: computeLineAmountCents(l.quantity, l.unit_price_cents),
      revenue_account_id: l.revenue_account_id,
    }));
    const { error: linesErr } = await supabase.from('estimate_lines').insert(lineInserts);
    if (linesErr) return NextResponse.json({ error: linesErr.message }, { status: 500 });
  } else if (body.tax_cents !== undefined) {
    // Tax-only change: recompute total from the stored subtotal.
    const { data: cur } = await supabase
      .from('estimates').select('subtotal_cents').eq('id', params.id).maybeSingle();
    const subtotal = Number(cur?.subtotal_cents ?? 0);
    update.tax_cents = body.tax_cents;
    update.total_cents = subtotal + body.tax_cents;
  }

  const { error: updErr } = await supabase
    .from('estimates').update(update).eq('org_id', orgId).eq('id', params.id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
