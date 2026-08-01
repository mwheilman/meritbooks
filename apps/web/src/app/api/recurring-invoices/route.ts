export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { fetchCoreMap } from '@/lib/stitch-core';
import { initialNextRunDate, type TemplateData } from '@/lib/invoices/recurring-invoices';

/**
 * Recurring invoice templates (FPB-invoices Wave C, D6.1 — recurring was MISSING,
 * a named delta vs QBO/Sage). A template repeats a customer bill on a cadence;
 * the /generate action mints real invoices from it through the shared create core.
 *
 * Reads run RLS-scoped (requireAuthedContext). Writes reuse the AR money-route
 * convention (requireAuth + requirePermission('invoices','create') + admin client
 * with an explicit org_id filter) established by invoice-create / credit-memos.
 */

// ─── GET: list templates ──────────────────────────────────────────────
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data, error } = await supabase
    .from('recurring_invoice_templates')
    .select('id, name, frequency, interval_count, start_date, next_run_date, end_date, occurrences_remaining, is_active, auto_send, template_data, last_generated_at, last_invoice_id, customer_id, location_id, created_at')
    .order('next_run_date', { ascending: true, nullsFirst: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))] as string[];
  const locationIds = [...new Set(rows.map((r) => r.location_id).filter(Boolean))] as string[];
  const custMap = await fetchCoreMap<{ id: string; name: string }>(supabase, 'customers', 'id, name', customerIds);
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(supabase, 'locations', 'id, name, short_code', locationIds);

  const today = new Date().toISOString().slice(0, 10);
  const templates = rows.map((t) => {
    const td = (t.template_data ?? {}) as TemplateData;
    const lines = Array.isArray(td.lines) ? td.lines : [];
    const subtotal = lines.reduce((s, l) => s + Math.round((l.quantity ?? 1) * l.unit_price_cents), 0);
    const amountCents = subtotal + (td.tax_cents ?? 0);
    const cust = t.customer_id ? custMap.get(t.customer_id as string) ?? null : null;
    const loc = t.location_id ? locMap.get(t.location_id as string) ?? null : null;
    const isDue = t.is_active && !!t.next_run_date && (t.next_run_date as string) <= today;
    return {
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
      amountCents,
      lineCount: lines.length,
      lastGeneratedAt: t.last_generated_at,
      lastInvoiceId: t.last_invoice_id,
      isDue,
      customer: cust ? { id: cust.id, name: cust.name } : null,
      location: loc ? { id: loc.id, name: loc.name, shortCode: loc.short_code } : null,
    };
  });

  const counts = { ALL: templates.length, ACTIVE: 0, PAUSED: 0, DUE: 0 };
  for (const t of templates) {
    if (t.isActive) counts.ACTIVE++; else counts.PAUSED++;
    if (t.isDue) counts.DUE++;
  }

  return NextResponse.json({ data: templates, counts });
}

// ─── POST: create a template ──────────────────────────────────────────
const lineSchema = z.object({
  description: z.string().min(1, 'Description required').max(500),
  account_id: z.string().uuid(),
  quantity: z.number().min(0).default(1),
  unit_price_cents: z.number().int(),
});

const createSchema = z.object({
  name: z.string().min(1, 'Name required').max(200),
  location_id: z.string().uuid(),
  customer_id: z.string().uuid(),
  job_id: z.string().uuid().optional().nullable(),
  frequency: z.enum(['WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']),
  interval_count: z.number().int().min(1).max(52).default(1),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  occurrences: z.number().int().positive().optional().nullable(),
  auto_send: z.boolean().default(false),
  memo: z.string().max(1000).optional(),
  tax_cents: z.number().int().min(0).default(0),
  terms: z.number().int().min(0).max(365).default(30),
  is_progress_bill: z.boolean().default(false),
  lines: z.array(lineSchema).min(1, 'At least one line item required'),
});

export async function POST(request: Request) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.issues }, { status: 422 });
  }
  const b = parsed.data;

  if (b.end_date && b.end_date < b.start_date) {
    return NextResponse.json({ error: 'End date cannot precede start date' }, { status: 422 });
  }

  const supabase = createAdminSupabase();

  const templateData: TemplateData = {
    lines: b.lines.map((l) => ({ description: l.description, account_id: l.account_id, quantity: l.quantity, unit_price_cents: l.unit_price_cents })),
    memo: b.memo ?? null,
    tax_cents: b.tax_cents,
    terms: b.terms,
    job_id: b.job_id ?? null,
    is_progress_bill: b.is_progress_bill,
  };

  const { data: tmpl, error } = await supabase
    .from('recurring_invoice_templates')
    .insert({
      org_id: orgId,
      location_id: b.location_id,
      customer_id: b.customer_id,
      name: b.name,
      frequency: b.frequency,
      interval_count: b.interval_count,
      start_date: b.start_date,
      next_run_date: initialNextRunDate(b.start_date),
      end_date: b.end_date ?? null,
      occurrences_remaining: b.occurrences ?? null,
      is_active: true,
      auto_send: b.auto_send,
      template_data: templateData,
      created_by: userId,
    })
    .select('id, name')
    .single();

  if (error || !tmpl) {
    return NextResponse.json({ error: error?.message ?? 'Failed to create template' }, { status: 500 });
  }

  return NextResponse.json({ id: tmpl.id, name: tmpl.name }, { status: 201 });
}
