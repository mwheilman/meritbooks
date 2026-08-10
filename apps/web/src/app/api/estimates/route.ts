export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { fetchCoreMap } from '@/lib/stitch-core';
import {
  computeEstimateTotals,
  computeLineAmountCents,
  formatEstimateNumber,
  nextEstimateSeq,
} from '@/lib/estimates/estimate-logic';

/**
 * Estimates / quotes (migration 139) — the AR front-of-funnel. An estimate is a
 * NON-POSTING sales document; it converts to a real invoice (which posts) via the
 * shared invoice-create path. Reads run RLS-scoped (requireAuthedContext); writes
 * follow the AR money-route convention (requireAuth + requirePermission +
 * admin client with an explicit org_id filter), the same one invoice-create and
 * credit-memos use.
 */

// ─── GET: list estimates ───────────────────────────────────────────────
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get('location_id');
  const customerId = searchParams.get('customer_id');
  const status = searchParams.get('status');
  const search = searchParams.get('search');

  let query = supabase
    .from('estimates')
    .select(
      `id, estimate_number, status, estimate_date, expiration_date,
       subtotal_cents, tax_cents, total_cents, currency, notes,
       customer_id, location_id, job_id, converted_invoice_id, converted_at, created_at`,
    )
    .order('estimate_date', { ascending: false });

  if (locationId) query = query.eq('location_id', locationId);
  if (customerId) query = query.eq('customer_id', customerId);
  if (status && status !== 'ALL') query = query.eq('status', status);
  if (search) query = query.ilike('estimate_number', `%${search}%`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))] as string[];
  const locationIds = [...new Set(rows.map((r) => r.location_id).filter(Boolean))] as string[];

  const custMap = await fetchCoreMap<{ id: string; name: string; email: string | null }>(
    supabase, 'customers', 'id, name, email', customerIds);
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', locationIds);

  const today = new Date().toISOString().slice(0, 10);

  const estimates = rows.map((e) => {
    const cust = e.customer_id ? custMap.get(e.customer_id as string) ?? null : null;
    const loc = e.location_id ? locMap.get(e.location_id as string) ?? null : null;
    const isExpiredByDate =
      !!e.expiration_date &&
      String(e.expiration_date) < today &&
      !['CONVERTED', 'DECLINED', 'EXPIRED', 'ACCEPTED'].includes(e.status as string);
    return {
      id: e.id,
      estimateNumber: e.estimate_number,
      status: e.status,
      estimateDate: e.estimate_date,
      expirationDate: e.expiration_date,
      subtotalCents: Number(e.subtotal_cents ?? 0),
      taxCents: Number(e.tax_cents ?? 0),
      totalCents: Number(e.total_cents ?? 0),
      currency: e.currency ?? 'USD',
      notes: e.notes,
      convertedInvoiceId: e.converted_invoice_id,
      convertedAt: e.converted_at,
      isPastExpiration: isExpiredByDate,
      customer: cust ? { id: cust.id, name: cust.name, email: cust.email } : null,
      location: loc ? { id: loc.id, name: loc.name, shortCode: loc.short_code } : null,
    };
  });

  // Status tiles + pipeline metrics (win-rate strip).
  const counts: Record<string, { count: number; totalCents: number }> = {
    ALL: { count: 0, totalCents: 0 },
    DRAFT: { count: 0, totalCents: 0 },
    SENT: { count: 0, totalCents: 0 },
    ACCEPTED: { count: 0, totalCents: 0 },
    DECLINED: { count: 0, totalCents: 0 },
    EXPIRED: { count: 0, totalCents: 0 },
    CONVERTED: { count: 0, totalCents: 0 },
  };
  let openPipelineCents = 0; // DRAFT + SENT (still live, undecided)
  let acceptedCents = 0; // ACCEPTED + CONVERTED (won)
  let decidedCents = 0; // ACCEPTED + CONVERTED + DECLINED (win-rate denominator)

  for (const e of estimates) {
    counts.ALL.count++;
    counts.ALL.totalCents += e.totalCents;
    const st = e.status as string;
    if (counts[st]) {
      counts[st].count++;
      counts[st].totalCents += e.totalCents;
    }
    if (st === 'DRAFT' || st === 'SENT') openPipelineCents += e.totalCents;
    if (st === 'ACCEPTED' || st === 'CONVERTED') {
      acceptedCents += e.totalCents;
      decidedCents += e.totalCents;
    }
    if (st === 'DECLINED') decidedCents += e.totalCents;
  }

  const winRatePct = decidedCents > 0 ? Math.round((acceptedCents / decidedCents) * 1000) / 10 : 0;

  return NextResponse.json({
    data: estimates,
    counts,
    pipeline: { openPipelineCents, acceptedCents, decidedCents, winRatePct },
  });
}

// ─── POST: create a draft estimate ─────────────────────────────────────
const createSchema = z.object({
  location_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  job_id: z.string().uuid().optional().nullable(),
  estimate_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expiration_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  notes: z.string().max(2000).optional(),
  tax_cents: z.number().int().min(0).default(0),
  currency: z.string().length(3).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1, 'Description required').max(500),
        revenue_account_id: z.string().uuid('A revenue account is required'),
        quantity: z.number().min(0).default(1),
        unit_price_cents: z.number().int(),
      }),
    )
    .min(1, 'At least one line item is required'),
});

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Creating an estimate is an AR write — gate on invoices:create (same as credit memos).
  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.issues },
      { status: 422 },
    );
  }
  const body = parsed.data;
  const supabase = createAdminSupabase();

  const totals = computeEstimateTotals(
    body.lines.map((l) => ({ quantity: l.quantity, unit_price_cents: l.unit_price_cents })),
    body.tax_cents,
  );

  // Mint the Books-owned estimate number: EST-{YYYYMMDD}-{seq} (per-org sequence).
  const { count } = await supabase
    .from('estimates')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId);
  const estimateNumber = formatEstimateNumber(body.estimate_date, nextEstimateSeq(count));

  const { data: est, error: estErr } = await supabase
    .from('estimates')
    .insert({
      org_id: orgId,
      location_id: body.location_id,
      customer_id: body.customer_id,
      job_id: body.job_id ?? null,
      estimate_number: estimateNumber,
      status: 'DRAFT',
      estimate_date: body.estimate_date,
      expiration_date: body.expiration_date ?? null,
      subtotal_cents: totals.subtotalCents,
      tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      currency: body.currency ?? 'USD',
      notes: body.notes ?? null,
      created_by: userId,
    })
    .select('id, estimate_number')
    .single();

  if (estErr || !est) {
    return NextResponse.json({ error: estErr?.message ?? 'Failed to create estimate' }, { status: 500 });
  }

  const lineInserts = body.lines.map((l, i) => ({
    org_id: orgId,
    estimate_id: est.id,
    line_number: i + 1,
    description: l.description,
    quantity: l.quantity,
    unit_price_cents: l.unit_price_cents,
    amount_cents: computeLineAmountCents(l.quantity, l.unit_price_cents),
    revenue_account_id: l.revenue_account_id,
  }));
  const { error: linesErr } = await supabase.from('estimate_lines').insert(lineInserts);
  if (linesErr) {
    await supabase.from('estimates').delete().eq('id', est.id);
    return NextResponse.json({ error: linesErr.message }, { status: 500 });
  }

  return NextResponse.json(
    { id: est.id, estimate_number: estimateNumber, total_cents: totals.totalCents },
    { status: 201 },
  );
}
