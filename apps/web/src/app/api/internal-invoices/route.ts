export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';
import { z } from 'zod';

const lineSchema = z.object({
  description: z.string().min(1).max(300),
  amount_cents: z.number().int().positive(),
});

const createSchema = z.object({
  location_id: z.string().uuid(),
  provider_department_id: z.string().uuid(),
  receiver_department_id: z.string().uuid(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().max(1000).optional().nullable(),
  job_id: z.string().uuid().optional().nullable(),
  lines: z.array(lineSchema).min(1),
});

// Generate the next per-org invoice number: II-000001, II-000002, ...
async function nextInvoiceNumber(
  supabase: SupabaseClient,
  orgId: string,
): Promise<string> {
  const { data } = await supabase
    .from('internal_invoices')
    .select('invoice_number')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(200);
  let max = 0;
  for (const row of data ?? []) {
    const m = /^II-(\d+)$/.exec((row as { invoice_number: string }).invoice_number ?? '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `II-${String(max + 1).padStart(6, '0')}`;
}

export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ data: [], counts: {} });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  const locationId = searchParams.get('location_id');

  let query = supabase
    .from('internal_invoices')
    .select(`
      id, invoice_number, invoice_date, memo, status, charge_method, total_cents,
      job_id, booked_gl_entry_id, rejection_reason, created_at,
      sent_at, approved_at, rejected_at, booked_at,
      location_id, provider_department_id, receiver_department_id
    `)
    .eq('org_id', orgId);

  if (locationId) query = query.eq('location_id', locationId);
  if (status && status !== 'all') query = query.eq('status', status);

  query = query.order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });

  // Stitch core entities (location + provider/receiver departments).
  const raw = (data ?? []) as Array<Record<string, any>>;
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', raw.map((r) => r.location_id));
  const deptMap = await fetchCoreMap<{ id: string; name: string; code: string }>(
    supabase, 'departments', 'id, name, code',
    [...raw.map((r) => r.provider_department_id), ...raw.map((r) => r.receiver_department_id)]);
  for (const r of raw) {
    r.location = r.location_id ? locMap.get(r.location_id) ?? null : null;
    r.provider = r.provider_department_id ? deptMap.get(r.provider_department_id) ?? null : null;
    r.receiver = r.receiver_department_id ? deptMap.get(r.receiver_department_id) ?? null : null;
  }

  const rows = raw.map((r: Record<string, unknown>) => ({
    id: r.id,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date,
    memo: r.memo,
    status: r.status,
    chargeMethod: r.charge_method,
    totalCents: Number(r.total_cents ?? 0),
    jobId: r.job_id,
    bookedGlEntryId: r.booked_gl_entry_id,
    rejectionReason: r.rejection_reason,
    sentAt: r.sent_at,
    approvedAt: r.approved_at,
    rejectedAt: r.rejected_at,
    bookedAt: r.booked_at,
    createdAt: r.created_at,
    location: r.location,
    provider: r.provider,
    receiver: r.receiver,
  }));

  const statuses = ['draft', 'sent', 'approved', 'rejected', 'booked', 'void'] as const;
  const counts: Record<string, number> = {};
  for (const s of statuses) {
    let q = supabase.from('internal_invoices').select('id', { count: 'exact', head: true })
      .eq('org_id', orgId).eq('status', s);
    if (locationId) q = q.eq('location_id', locationId);
    const { count } = await q;
    counts[s] = count ?? 0;
  }
  counts['all'] = Object.values(counts).reduce((a, b) => a + b, 0);

  return NextResponse.json({ data: rows, counts });
}

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase } = ctx;

  let body: z.infer<typeof createSchema>;
  try {
    const result = createSchema.safeParse(await request.json());
    if (!result.success) {
      return NextResponse.json({
        error: 'Validation failed', code: 'VALIDATION_ERROR',
        details: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      }, { status: 422 });
    }
    body = result.data;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  if (body.provider_department_id === body.receiver_department_id) {
    return NextResponse.json({ error: 'Provider and receiver departments must differ', code: 'SAME_DEPT' }, { status: 422 });
  }

  // Resolve org from location and verify both departments belong to this company
  const { data: loc } = await supabase.schema('core').from('locations').select('id, org_id').eq('id', body.location_id).single();
  if (!loc) return NextResponse.json({ error: 'Company not found', code: 'NOT_FOUND' }, { status: 404 });
  const orgId = loc.org_id as string;

  const { data: depts } = await supabase
    .schema('core').from('departments')
    .select('id, location_id, is_active')
    .in('id', [body.provider_department_id, body.receiver_department_id]);
  const deptList = depts ?? [];
  if (deptList.length !== 2 || deptList.some((d) => d.location_id !== body.location_id)) {
    return NextResponse.json({ error: 'Both departments must belong to the selected company', code: 'DEPT_MISMATCH' }, { status: 422 });
  }

  const totalCents = body.lines.reduce((s, l) => s + l.amount_cents, 0);
  const invoiceNumber = await nextInvoiceNumber(supabase, orgId);

  const { data: invoice, error: invErr } = await supabase
    .from('internal_invoices')
    .insert({
      org_id: orgId,
      location_id: body.location_id,
      invoice_number: invoiceNumber,
      invoice_date: body.invoice_date,
      memo: body.memo ?? null,
      provider_department_id: body.provider_department_id,
      receiver_department_id: body.receiver_department_id,
      job_id: body.job_id ?? null,
      status: 'draft',
      total_cents: totalCents,
      created_by: null, // attribution columns are uuid; Clerk IDs are text — see follow-up
    })
    .select('id, invoice_number')
    .single();
  if (invErr || !invoice) {
    return NextResponse.json({ error: `Failed to create invoice: ${invErr?.message}`, code: 'INSERT_ERROR' }, { status: 500 });
  }

  const lineInserts = body.lines.map((l, i) => ({
    org_id: orgId,
    internal_invoice_id: invoice.id,
    line_number: i + 1,
    description: l.description,
    amount_cents: l.amount_cents,
  }));
  const { error: linesErr } = await supabase.from('internal_invoice_lines').insert(lineInserts);
  if (linesErr) {
    await supabase.from('internal_invoices').delete().eq('id', invoice.id);
    return NextResponse.json({ error: `Failed to add lines: ${linesErr.message}`, code: 'LINES_ERROR' }, { status: 500 });
  }

  return NextResponse.json({ success: true, id: invoice.id, invoiceNumber: invoice.invoice_number }, { status: 201 });
}
