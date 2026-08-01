export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { fetchCoreMap } from '@/lib/stitch-core';

/**
 * Customer credit memos (FPB-invoices Wave B, D5.1). A credit memo is a
 * negative-signed AR document that reduces what a customer owes. Books owns the
 * credit_number. It posts DR revenue/deferred + sales-tax reversal / CR AR on
 * approval (see [id]/post) and applies against an open invoice (see [id]/apply).
 *
 * Reads run RLS-scoped (requireAuthedContext). Writes reuse the AR money-route
 * convention (requireAuth + requirePermission + admin client with explicit
 * org_id filter) established by the invoice-create / payments routes.
 */

// ─── GET: list credit memos ───────────────────────────────────────────
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const invoiceId = searchParams.get('invoice_id');
  const customerId = searchParams.get('customer_id');
  const status = searchParams.get('status');

  let query = supabase
    .from('credit_memos')
    .select(`
      id, credit_number, credit_date, status, memo, reason,
      subtotal_cents, tax_cents, total_cents, applied_amount_cents,
      customer_id, location_id, invoice_id, gl_entry_id, created_at
    `)
    .order('credit_date', { ascending: false });

  if (invoiceId) query = query.eq('invoice_id', invoiceId);
  if (customerId) query = query.eq('customer_id', customerId);
  if (status && status !== 'ALL') query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))] as string[];
  const locationIds = [...new Set(rows.map((r) => r.location_id).filter(Boolean))] as string[];

  const custMap = await fetchCoreMap<{ id: string; name: string }>(supabase, 'customers', 'id, name', customerIds);
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', locationIds);

  const memos = rows.map((m) => {
    const cust = m.customer_id ? custMap.get(m.customer_id as string) ?? null : null;
    const loc = m.location_id ? locMap.get(m.location_id as string) ?? null : null;
    const total = Number(m.total_cents ?? 0);
    const applied = Number(m.applied_amount_cents ?? 0);
    return {
      id: m.id,
      creditNumber: m.credit_number,
      creditDate: m.credit_date,
      status: m.status,
      memo: m.memo,
      reason: m.reason,
      subtotalCents: Number(m.subtotal_cents ?? 0),
      taxCents: Number(m.tax_cents ?? 0),
      totalCents: total,
      appliedCents: applied,
      unappliedCents: Math.max(0, total - applied),
      invoiceId: m.invoice_id,
      glEntryId: m.gl_entry_id,
      customer: cust ? { id: cust.id, name: cust.name } : null,
      location: loc ? { id: loc.id, name: loc.name, shortCode: loc.short_code } : null,
    };
  });

  // Summary tiles: count + total by lifecycle state.
  const counts = { ALL: 0, DRAFT: 0, POSTED: 0, APPLIED: 0, VOIDED: 0 } as Record<string, number>;
  let openCreditCents = 0;
  for (const m of memos) {
    counts.ALL++;
    if (counts[m.status] !== undefined) counts[m.status]++;
    if (m.status === 'POSTED') openCreditCents += m.unappliedCents;
  }

  return NextResponse.json({ data: memos, counts, openCreditCents });
}

// ─── POST: create a draft credit memo ─────────────────────────────────
const createSchema = z.object({
  location_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  invoice_id: z.string().uuid().optional().nullable(),
  credit_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().max(1000).optional(),
  reason: z.string().max(500).optional(),
  tax_cents: z.number().int().min(0).default(0),
  lines: z.array(z.object({
    account_id: z.string().uuid(),
    description: z.string().max(500).optional(),
    amount_cents: z.number().int().positive('Line amount must be positive'),
    department_id: z.string().uuid().optional().nullable(),
    class_id: z.string().uuid().optional().nullable(),
  })).min(1, 'At least one line is required'),
});

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Creating a credit memo is an AR write — gate on invoices:create.
  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.issues }, { status: 422 });
  }
  const body = parsed.data;
  const supabase = createAdminSupabase();

  // If linked to an invoice, verify it belongs to this org + customer (defense
  // in depth on top of RLS) so a credit can't be aimed at another tenant's AR.
  if (body.invoice_id) {
    const { data: inv } = await supabase
      .from('invoices').select('id, customer_id, location_id').eq('org_id', orgId).eq('id', body.invoice_id).maybeSingle();
    if (!inv) return NextResponse.json({ error: 'Linked invoice not found in this organization' }, { status: 404 });
    if ((inv as { customer_id: string }).customer_id !== body.customer_id) {
      return NextResponse.json({ error: 'Linked invoice belongs to a different customer' }, { status: 422 });
    }
  }

  const subtotalCents = body.lines.reduce((s, l) => s + l.amount_cents, 0);
  const totalCents = subtotalCents + body.tax_cents;

  // Mint the Books-owned credit number: CM-{YYYYMMDD}-{seq} (per-org sequence).
  const dateStr = body.credit_date.replace(/-/g, '');
  const { count } = await supabase
    .from('credit_memos').select('*', { count: 'exact', head: true }).eq('org_id', orgId);
  const creditNumber = `CM-${dateStr}-${String((count ?? 0) + 1).padStart(4, '0')}`;

  const { data: memo, error: memoErr } = await supabase
    .from('credit_memos')
    .insert({
      org_id: orgId,
      location_id: body.location_id,
      customer_id: body.customer_id,
      invoice_id: body.invoice_id ?? null,
      credit_number: creditNumber,
      credit_date: body.credit_date,
      memo: body.memo ?? null,
      reason: body.reason ?? null,
      subtotal_cents: subtotalCents,
      tax_cents: body.tax_cents,
      total_cents: totalCents,
      status: 'DRAFT',
      // credit_memos.created_by is text (Clerk id) — safe to store, unlike the
      // uuid GL author columns.
      created_by: userId,
    })
    .select('id, credit_number')
    .single();

  if (memoErr || !memo) {
    return NextResponse.json({ error: memoErr?.message ?? 'Failed to create credit memo' }, { status: 500 });
  }

  const lineInserts = body.lines.map((l) => ({
    org_id: orgId,
    credit_memo_id: memo.id,
    account_id: l.account_id,
    description: l.description ?? null,
    amount_cents: l.amount_cents,
    department_id: l.department_id ?? null,
    class_id: l.class_id ?? null,
  }));
  const { error: linesErr } = await supabase.from('credit_memo_lines').insert(lineInserts);
  if (linesErr) {
    await supabase.from('credit_memos').delete().eq('id', memo.id);
    return NextResponse.json({ error: linesErr.message }, { status: 500 });
  }

  return NextResponse.json({ id: memo.id, credit_number: creditNumber, total_cents: totalCents }, { status: 201 });
}
