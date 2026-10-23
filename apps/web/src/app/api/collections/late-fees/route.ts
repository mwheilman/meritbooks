export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { decideLateFees } from '@/lib/collections/late-fees';
import { fetchCoreMap } from '@/lib/stitch-core';
import { getOrgToday } from '@/lib/dates/org-today';
import { isWriteScopeError } from '@/lib/db/scoped-writer';
import { logHumanAction } from '@/lib/trust/action-log';

const querySchema = z
  .object({
    status: z.enum(['PROPOSED', 'APPROVED', 'REJECTED']).optional().default('PROPOSED'),
    limit: z.coerce.number().int().min(1).max(200).optional().default(100),
    offset: z.coerce.number().int().min(0).optional().default(0),
  })
  .strict();

interface AssessmentListRow {
  id: string;
  location_id: string;
  invoice_id: string;
  customer_id: string | null;
  period_key: string;
  as_of: string;
  days_past_due: number;
  base_cents: number | string;
  fee_cents: number | string;
  method: string;
  rate_bps: number | null;
  status: string;
  finance_charge_invoice_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

/**
 * GET /api/collections/late-fees?status=PROPOSED — the late-fee queue the nightly
 * `ar.late_fees` job proposed (Settings → Automation → Late fees). RLS-scoped read
 * (org + client scope). AUTHZ: invoices:view.
 */
export const GET = apiQueryHandler(querySchema, async (q, ctx) => {
  const guard = await requirePermission(ctx.userId, 'invoices', 'view');
  if (!guard.ok) return guard.response;
  const { data, error, count } = await ctx.supabase
    .from('late_fee_assessments')
    .select('id, location_id, invoice_id, customer_id, period_key, as_of, days_past_due, base_cents, fee_cents, method, rate_bps, status, finance_charge_invoice_id, decided_by, decided_at, decision_note, created_at', { count: 'exact' })
    .eq('org_id', guard.orgId)
    .eq('status', q.status ?? 'PROPOSED')
    .order('created_at', { ascending: false })
    .range(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 100) - 1);
  if (error) return NextResponse.json({ error: error.message, code: 'DB_ERROR' }, { status: 500 });
  const rows = (data ?? []) as AssessmentListRow[];

  const invIds = Array.from(new Set([...rows.map((r) => r.invoice_id), ...rows.map((r) => r.finance_charge_invoice_id).filter((x): x is string => !!x)]));
  const { data: invData } = invIds.length
    ? await ctx.supabase.from('invoices').select('id, invoice_number, due_date, balance_cents').in('id', invIds)
    : { data: [] };
  const inv = new Map(((invData ?? []) as Array<{ id: string; invoice_number: string; due_date: string; balance_cents: number | string }>).map((r) => [r.id, r]));
  const [custs, locs] = await Promise.all([
    fetchCoreMap<{ id: string; name: string; display_name: string | null }>(ctx.supabase, 'customers', 'id, name, display_name', rows.map((r) => r.customer_id)),
    fetchCoreMap<{ id: string; name: string; short_code: string | null }>(ctx.supabase, 'locations', 'id, name, short_code', rows.map((r) => r.location_id)),
  ]);

  const out = rows.map((r) => {
    const c = r.customer_id ? custs.get(r.customer_id) : undefined;
    const l = locs.get(r.location_id);
    const i = inv.get(r.invoice_id);
    const fc = r.finance_charge_invoice_id ? inv.get(r.finance_charge_invoice_id) : undefined;
    return {
      id: r.id,
      locationId: r.location_id,
      company: l ? l.short_code || l.name : '—',
      customer: c ? c.display_name || c.name : '—',
      invoiceId: r.invoice_id,
      invoiceNumber: i?.invoice_number ?? '—',
      invoiceDueDate: i?.due_date ?? null,
      invoiceBalanceCents: i ? Number(i.balance_cents) : null,
      periodKey: r.period_key,
      asOf: r.as_of,
      daysPastDue: r.days_past_due,
      baseCents: Number(r.base_cents),
      feeCents: Number(r.fee_cents),
      method: r.method,
      rateBps: r.rate_bps,
      status: r.status,
      financeChargeInvoiceId: r.finance_charge_invoice_id,
      financeChargeInvoiceNumber: fc?.invoice_number ?? null,
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
      createdAt: r.created_at,
    };
  });
  return NextResponse.json({
    rows: out,
    total: count ?? out.length,
    totalFeeCents: out.reduce((s, r) => s + r.feeCents, 0),
  });
});

const decideSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(200),
    action: z.enum(['approve', 'reject']),
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((v) => v.action === 'approve' || (v.note ?? '').length >= 3, { message: 'Say why you are rejecting these fees.', path: ['note'] });

/**
 * POST /api/collections/late-fees { ids, action, note } — approve (→ one finance-charge
 * invoice per company + customer, posted to AR) or reject (never re-proposed for that
 * period) proposed late fees. AUTHZ: invoices:approve. Rows are read through the caller's
 * RLS client, so only fees in their org + client scope are touched. Audited.
 */
export const POST = apiHandler(decideSchema, async (body, ctx) => {
  const guard = await requirePermission(ctx.userId, 'invoices', 'approve');
  if (!guard.ok) return guard.response;
  try {
    const today = await getOrgToday(ctx.supabase, guard.orgId);
    const res = await decideLateFees(ctx.supabase, guard.orgId, { ids: body.ids, action: body.action, actor: ctx.userId, note: body.note ?? null, today });
    await logHumanAction(ctx.supabase, ctx.userId, guard.orgId, {
      action: body.action === 'approve' ? 'collections.late_fee.approve' : 'collections.late_fee.reject',
      subjectTable: 'late_fee_assessments',
      summary:
        body.action === 'approve'
          ? `Approved ${res.approved} late fee(s) → ${res.invoices.length} finance-charge invoice(s) ${res.invoices.map((i) => i.invoice_number).join(', ')}`.slice(0, 500)
          : `Rejected ${res.rejected} late fee(s): ${body.note ?? ''}`.slice(0, 500),
      metadata: { ids: body.ids, approved: res.approved, rejected: res.rejected, invoices: res.invoices.map((i) => i.invoice_id), errors: res.errors.slice(0, 5) },
    });
    const status = res.approved + res.rejected === 0 && res.errors.length > 0 ? 422 : 200;
    return NextResponse.json({ ok: status === 200, ...res, error: status === 422 ? res.errors[0] : undefined }, { status });
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 });
    throw e;
  }
});
