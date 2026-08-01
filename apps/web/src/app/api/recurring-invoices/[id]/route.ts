export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { fetchCoreMap } from '@/lib/stitch-core';
import { type TemplateData } from '@/lib/invoices/recurring-invoices';

/**
 * A single recurring invoice template: read (RLS-scoped), edit / pause / resume
 * (PATCH), and delete. All writes gate on invoices:create with an explicit
 * org_id filter (defense-in-depth on top of RLS).
 */

// ─── GET: template detail ─────────────────────────────────────────────
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: t, error } = await supabase
    .from('recurring_invoice_templates')
    .select('id, name, frequency, interval_count, start_date, next_run_date, end_date, occurrences_remaining, is_active, auto_send, template_data, last_generated_at, last_invoice_id, customer_id, location_id, created_at')
    .eq('id', params.id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!t) return NextResponse.json({ error: 'Template not found' }, { status: 404 });

  const td = (t.template_data ?? {}) as TemplateData;
  const lines = Array.isArray(td.lines) ? td.lines : [];
  const custMap = await fetchCoreMap<{ id: string; name: string }>(supabase, 'customers', 'id, name', t.customer_id ? [t.customer_id as string] : []);
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(supabase, 'locations', 'id, name, short_code', t.location_id ? [t.location_id as string] : []);
  const cust = t.customer_id ? custMap.get(t.customer_id as string) ?? null : null;
  const loc = t.location_id ? locMap.get(t.location_id as string) ?? null : null;
  const subtotal = lines.reduce((s, l) => s + Math.round((l.quantity ?? 1) * l.unit_price_cents), 0);

  return NextResponse.json({
    id: t.id,
    name: t.name,
    frequency: t.frequency,
    intervalCount: t.interval_count,
    startDate: t.start_date,
    nextRunDate: t.next_run_date,
    endDate: t.end_date,
    occurrencesRemaining: t.occurrences_remaining,
    isActive: t.is_active,
    autoSend: t.auto_send,
    memo: td.memo ?? null,
    taxCents: td.tax_cents ?? 0,
    terms: td.terms ?? 30,
    jobId: td.job_id ?? null,
    isProgressBill: td.is_progress_bill ?? false,
    subtotalCents: subtotal,
    amountCents: subtotal + (td.tax_cents ?? 0),
    lines: lines.map((l) => ({ description: l.description, accountId: l.account_id, quantity: l.quantity ?? 1, unitPriceCents: l.unit_price_cents })),
    lastGeneratedAt: t.last_generated_at,
    lastInvoiceId: t.last_invoice_id,
    customer: cust ? { id: cust.id, name: cust.name } : null,
    location: loc ? { id: loc.id, name: loc.name, shortCode: loc.short_code } : null,
  });
}

// ─── PATCH: edit / pause / resume ─────────────────────────────────────
const lineSchema = z.object({
  description: z.string().min(1).max(500),
  account_id: z.string().uuid(),
  quantity: z.number().min(0).default(1),
  unit_price_cents: z.number().int(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  frequency: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']).optional(),
  interval_count: z.number().int().min(1).max(52).optional(),
  next_run_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  occurrences_remaining: z.number().int().min(0).nullable().optional(),
  is_active: z.boolean().optional(),
  auto_send: z.boolean().optional(),
  memo: z.string().max(1000).nullable().optional(),
  tax_cents: z.number().int().min(0).optional(),
  terms: z.number().int().min(0).max(365).optional(),
  is_progress_bill: z.boolean().optional(),
  lines: z.array(lineSchema).min(1).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.issues }, { status: 422 });
  }
  const b = parsed.data;
  const supabase = createAdminSupabase();

  // Load current row (scoped to org) so template_data edits merge, not clobber.
  const { data: current } = await supabase
    .from('recurring_invoice_templates')
    .select('template_data')
    .eq('id', params.id)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!current) return NextResponse.json({ error: 'Template not found' }, { status: 404 });

  const td = { ...((current.template_data ?? {}) as TemplateData) };
  if (b.lines !== undefined) td.lines = b.lines.map((l) => ({ description: l.description, account_id: l.account_id, quantity: l.quantity, unit_price_cents: l.unit_price_cents }));
  if (b.memo !== undefined) td.memo = b.memo;
  if (b.tax_cents !== undefined) td.tax_cents = b.tax_cents;
  if (b.terms !== undefined) td.terms = b.terms;
  if (b.is_progress_bill !== undefined) td.is_progress_bill = b.is_progress_bill;

  const update: Record<string, unknown> = { template_data: td, updated_at: new Date().toISOString() };
  if (b.name !== undefined) update.name = b.name;
  if (b.frequency !== undefined) update.frequency = b.frequency;
  if (b.interval_count !== undefined) update.interval_count = b.interval_count;
  if (b.next_run_date !== undefined) update.next_run_date = b.next_run_date;
  if (b.end_date !== undefined) update.end_date = b.end_date;
  if (b.occurrences_remaining !== undefined) update.occurrences_remaining = b.occurrences_remaining;
  if (b.is_active !== undefined) update.is_active = b.is_active;
  if (b.auto_send !== undefined) update.auto_send = b.auto_send;

  const { error } = await supabase
    .from('recurring_invoice_templates')
    .update(update)
    .eq('id', params.id)
    .eq('org_id', orgId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// ─── DELETE: remove a template (generated invoices are unaffected) ────
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  const supabase = createAdminSupabase();
  const { error } = await supabase
    .from('recurring_invoice_templates')
    .delete()
    .eq('id', params.id)
    .eq('org_id', orgId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
