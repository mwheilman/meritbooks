export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * AP Purchase Orders (GATE 11b, migration 080) — general (non-job) vendor
 * procurement. Distinct from proj.commitments (the job/subcontract PO the Projects
 * module owns).
 *
 *   GET  → list POs for the caller's org (RLS-scoped) with line/received/billed roll-ups.
 *   POST → create a PO. Books mints the po_number (canon §2 numbering owner), UNIQUE
 *          per org. Lines carry ordered qty × unit cost (bigint cents).
 *
 * RBAC: reuses the `bills` (AP) permission as defense-in-depth on RLS — a PO is an
 * AP commitment. (A dedicated `purchase_orders` permission is reported to the lead.)
 */

const lineSchema = z.object({
  description: z.string().max(500).optional(),
  account_id: z.string().uuid().nullable().optional(),
  item_id: z.string().uuid().nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
  job_id: z.string().uuid().nullable().optional(),
  quantity: z.number().nonnegative(),
  unit_cost_cents: z.number().int().nonnegative(),
});

const createSchema = z.object({
  vendor_id: z.string().uuid(),
  location_id: z.string().uuid().nullable().optional(),
  order_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expected_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  memo: z.string().max(1000).optional(),
  tax_cents: z.number().int().nonnegative().default(0),
  status: z.enum(['DRAFT', 'OPEN']).default('OPEN'),
  lines: z.array(lineSchema).min(1, 'A purchase order needs at least one line.'),
});
type CreateBody = z.infer<typeof createSchema>;

/** Mint a Books-owned PO number, UNIQUE per org: PO-YYYYMM-#### (defensive loop). */
async function mintPoNumber(
  supabase: SupabaseClient,
  orgId: string,
  isoDate: string,
): Promise<string> {
  const ym = isoDate.slice(0, 7).replace('-', '');
  const { count } = await supabase
    .from('purchase_orders')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId);
  let seq = (count ?? 0) + 1;
  for (let i = 0; i < 50; i++) {
    const candidate = `PO-${ym}-${String(seq).padStart(4, '0')}`;
    const { data } = await supabase
      .from('purchase_orders')
      .select('id')
      .eq('org_id', orgId)
      .eq('po_number', candidate)
      .maybeSingle();
    if (!data) return candidate;
    seq++;
  }
  return `PO-${ym}-${Date.now()}`;
}

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ purchase_orders: [] });

  const { data: pos, error } = await supabase
    .from('purchase_orders')
    .select(
      'id, po_number, vendor_id, location_id, status, order_date, expected_date, memo, subtotal_cents, tax_cents, total_cents, received_total_cents, billed_total_cents, created_at',
    )
    .eq('org_id', orgId)
    .order('order_date', { ascending: false })
    .limit(500);
  if (error) {
    return NextResponse.json({ error: error.message, code: 'PO_LIST_FAILED' }, { status: 500 });
  }

  // Stitch vendor names from core (PostgREST can't embed core from public).
  const vendorIds = [...new Set((pos ?? []).map((p) => p.vendor_id).filter(Boolean))] as string[];
  const vendorName = new Map<string, string>();
  if (vendorIds.length > 0) {
    const { data: vs } = await supabase
      .schema('core')
      .from('vendors')
      .select('id, name, display_name')
      .in('id', vendorIds);
    for (const v of (vs ?? []) as Array<{ id: string; name: string; display_name: string | null }>) {
      vendorName.set(v.id, v.display_name || v.name);
    }
  }

  return NextResponse.json({
    purchase_orders: (pos ?? []).map((p) => ({
      ...p,
      vendor_name: vendorName.get(p.vendor_id as string) ?? 'Unknown vendor',
    })),
  });
}

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }

  const guard = await requirePermission(userId, 'bills', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '_root';
      (details[path] ??= []).push(issue.message);
    }
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR', details }, { status: 422 });
  }
  const body: CreateBody = parsed.data;

  const orderDate = body.order_date ?? new Date().toISOString().slice(0, 10);
  const subtotalCents = body.lines.reduce(
    (s, l) => s + Math.round(l.quantity * l.unit_cost_cents),
    0,
  );
  const totalCents = subtotalCents + body.tax_cents;
  const poNumber = await mintPoNumber(supabase as unknown as SupabaseClient, orgId, orderDate);

  const { data: po, error: poErr } = await supabase
    .from('purchase_orders')
    .insert({
      org_id: orgId,
      vendor_id: body.vendor_id,
      location_id: body.location_id ?? null,
      po_number: poNumber,
      status: body.status,
      order_date: orderDate,
      expected_date: body.expected_date ?? null,
      memo: body.memo ?? null,
      subtotal_cents: subtotalCents,
      tax_cents: body.tax_cents,
      total_cents: totalCents,
      created_by: null,
      created_by_user: userId,
    })
    .select('id, po_number')
    .single();
  if (poErr || !po) {
    return NextResponse.json({ error: poErr?.message ?? 'Failed to create PO', code: 'PO_CREATE_FAILED' }, { status: 500 });
  }

  const lineRows = body.lines.map((l, i) => ({
    org_id: orgId,
    po_id: po.id,
    line_number: i + 1,
    description: l.description ?? null,
    account_id: l.account_id ?? null,
    item_id: l.item_id ?? null,
    department_id: l.department_id ?? null,
    job_id: l.job_id ?? null,
    quantity: l.quantity,
    unit_cost_cents: l.unit_cost_cents,
    amount_cents: Math.round(l.quantity * l.unit_cost_cents),
    received_qty: 0,
    billed_qty: 0,
  }));
  const { error: lineErr } = await supabase.from('purchase_order_lines').insert(lineRows);
  if (lineErr) {
    await supabase.from('purchase_orders').delete().eq('id', po.id);
    return NextResponse.json({ error: lineErr.message, code: 'PO_LINES_FAILED' }, { status: 500 });
  }

  await logHumanAction(supabase, userId, orgId, {
    action: 'purchase_order.create',
    subjectTable: 'purchase_orders',
    subjectId: po.id as string,
    summary: `Created ${po.po_number} (${(totalCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })})`,
    locationId: body.location_id ?? null,
  });

  return NextResponse.json({ purchase_order_id: po.id, po_number: po.po_number, total_cents: totalCents }, { status: 201 });
}
