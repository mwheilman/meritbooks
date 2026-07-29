export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';
import { billTransitionSchema } from '@/lib/validations/transactions';
import { approveBill, scheduleBill, payBill, voidBill } from '@/lib/services/bill-ap';

// GET /api/bills/[id] — full bill detail for the AP panel.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: bill, error } = await supabase
    .from('bills')
    .select(`
      id, bill_number, bill_date, due_date, received_date,
      subtotal_cents, tax_cents, total_cents, amount_paid_cents, balance_cents,
      status, payment_hold_reason, scheduled_payment_date, payment_method, paid_at,
      approver_type, approver_ref, approved_by_user, approved_at, void_reason,
      gl_entry_id, location_id, vendor_id
    `)
    .eq('org_id', orgId)
    .eq('id', params.id)
    .single();

  if (error || !bill) return NextResponse.json({ error: 'Bill not found' }, { status: 404 });

  // Stitch core entities (location/vendor) onto the bill — cross-schema embeds don't work.
  {
    const b = bill as Record<string, any>;
    const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
      supabase, 'locations', 'id, name, short_code', [b.location_id]);
    const venMap = await fetchCoreMap<{ id: string; name: string; display_name: string | null; is_1099_eligible: boolean }>(
      supabase, 'vendors', 'id, name, display_name, is_1099_eligible', [b.vendor_id]);
    b.location = b.location_id ? locMap.get(b.location_id) ?? null : null;
    b.vendor = b.vendor_id ? venMap.get(b.vendor_id) ?? null : null;
  }

  const { data: lines } = await supabase
    .from('bill_lines')
    .select(`
      id, line_number, description, quantity, unit_cost_cents, amount_cents, job_id,
      account:accounts!bill_lines_account_id_fkey(id, account_number, name, account_type)
    `)
    .eq('bill_id', params.id)
    .order('line_number', { ascending: true });

  // Resolve job names for tagged lines.
  const jobIds = [...new Set((lines ?? []).map((l) => (l as { job_id: string | null }).job_id).filter(Boolean) as string[])];
  const jobMap = new Map<string, { id: string; job_number: string; name: string }>();
  if (jobIds.length > 0) {
    const { data: jobs } = await supabase.schema('core').from('jobs').select('id, job_number, name').in('id', jobIds);
    for (const j of jobs ?? []) jobMap.set((j as { id: string }).id, j as { id: string; job_number: string; name: string });
  }

  // Attributions (committed/cleared costs) for this bill.
  const { data: attributions } = await supabase
    .from('job_cost_attributions')
    .select('id, job_id, cost_type, amount_cents, lifecycle, gate, approver_type, approver_ref')
    .eq('org_id', orgId)
    .eq('bill_id', params.id);

  // Resolve the approver display name when routed to a person.
  let approverName: string | null = null;
  const ref = (bill as { approver_ref: string | null }).approver_ref;
  if (ref) {
    const { data: emp } = await supabase.schema('core').from('employees').select('first_name, last_name').eq('id', ref).maybeSingle();
    if (emp) approverName = `${(emp as { first_name: string }).first_name} ${(emp as { last_name: string }).last_name}`;
  }

  const enrichedLines = (lines ?? []).map((l) => ({
    ...(l as Record<string, unknown>),
    job: (l as { job_id: string | null }).job_id ? jobMap.get((l as { job_id: string }).job_id) ?? null : null,
  }));

  return NextResponse.json({
    bill,
    lines: enrichedLines,
    attributions: attributions ?? [],
    approver: { type: (bill as { approver_type: string | null }).approver_type, ref, name: approverName },
  });
}

// POST /api/bills/[id] — lifecycle transition (approve | schedule | pay | void | override_approver).
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const actor = userId;

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const parsed = billTransitionSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 422 });
  }
  const body = parsed.data;

  try {
    if (body.action === 'approve') {
      return NextResponse.json({ ok: true, ...(await approveBill(supabase, orgId, params.id, actor)) });
    }
    if (body.action === 'schedule') {
      return NextResponse.json({ ok: true, ...(await scheduleBill(supabase, orgId, params.id, body.scheduled_payment_date, body.payment_method ?? null)) });
    }
    if (body.action === 'pay') {
      const date = body.payment_date ?? new Date().toISOString().slice(0, 10);
      return NextResponse.json({ ok: true, ...(await payBill(supabase, orgId, params.id, body.amount_cents, date, body.payment_method ?? null)) });
    }
    if (body.action === 'void') {
      return NextResponse.json({ ok: true, ...(await voidBill(supabase, orgId, params.id, body.reason)) });
    }
    if (body.action === 'override_approver') {
      const { error } = await supabase
        .from('bills')
        .update({ approver_type: body.approver_type, approver_ref: body.approver_ref ?? null, updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .eq('id', params.id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, id: params.id, approver_type: body.approver_type });
    }
    if (body.action === 'release_hold') {
      const { data: bill } = await supabase
        .from('bills')
        .select('status, payment_hold_reason')
        .eq('org_id', orgId)
        .eq('id', params.id)
        .single();
      if (!bill) throw new Error('Bill not found');
      if ((bill as { status: string }).status !== 'ON_HOLD') {
        throw new Error('This bill is not on hold');
      }
      const { error } = await supabase
        .from('bills')
        .update({ status: 'PENDING', payment_hold_reason: null, updated_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .eq('id', params.id);
      if (error) throw new Error(error.message);
      // Audit the override (one-time release of this bill's compliance hold).
      await supabase.from('audit_log').insert({
        org_id: orgId,
        table_name: 'bills',
        record_id: params.id,
        action: 'UPDATE',
        field_name: 'payment_hold_release',
        old_value: (bill as { payment_hold_reason: string | null }).payment_hold_reason ?? 'ON_HOLD',
        new_value: `RELEASED (one-time): ${body.reason}`,
        user_id: actor,
      });
      return NextResponse.json({ ok: true, id: params.id, status: 'PENDING' });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Action failed' }, { status: 500 });
  }
}
