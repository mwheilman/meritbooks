export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { createAttribution, approveAttribution, voidAttribution, overrideApprover } from '@/lib/services/cost-approval';

async function getOrgId(supabase: ReturnType<typeof createAdminSupabase>): Promise<string | null> {
  const { data } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

// GET /api/cost-approvals?lifecycle=PENDING — the approval queue, enriched with job + company.
export async function GET(request: Request) {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const supabase = createAdminSupabase();
  const orgId = await getOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const lifecycle = new URL(request.url).searchParams.get('lifecycle') ?? 'PENDING';

  let q = supabase.from('job_cost_attributions').select('*').eq('org_id', orgId).order('created_at', { ascending: false });
  if (lifecycle !== 'all') q = q.eq('lifecycle', lifecycle);
  const { data: rows, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const jobIds = [...new Set((rows ?? []).map((r) => (r as { job_id: string }).job_id))];
  const locIds = [...new Set((rows ?? []).map((r) => (r as { location_id: string }).location_id))];
  const { data: jobs } = jobIds.length ? await supabase.schema('core').from('jobs').select('id, name, job_number').in('id', jobIds) : { data: [] };
  const { data: locs } = locIds.length ? await supabase.schema('core').from('locations').select('id, name, short_code').in('id', locIds) : { data: [] };
  const jobMap = new Map((jobs ?? []).map((j) => [(j as { id: string }).id, j]));
  const locMap = new Map((locs ?? []).map((l) => [(l as { id: string }).id, l]));

  const enriched = (rows ?? []).map((r) => ({
    ...(r as Record<string, unknown>),
    job: jobMap.get((r as { job_id: string }).job_id) ?? null,
    company: locMap.get((r as { location_id: string }).location_id) ?? null,
  }));
  return NextResponse.json({ data: enriched });
}

// POST /api/cost-approvals — { action: 'create'|'approve'|'void'|'override', ... }
export async function POST(request: Request) {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const supabase = createAdminSupabase();
  const orgId = await getOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const action = String(body.action ?? '');

  try {
    if (action === 'create') {
      const res = await createAttribution(supabase, {
        orgId,
        locationId: String(body.location_id),
        jobId: String(body.job_id),
        departmentId: (body.department_id as string) ?? null,
        costType: body.cost_type as 'LABOR' | 'MATERIALS' | 'SUBCONTRACTOR' | 'EQUIPMENT' | 'OTHER',
        amountCents: Math.round(Number(body.amount_cents)),
        occurredOn: String(body.occurred_on),
        gate: body.gate as 'PAYABLE_APPROVAL' | 'BANKFEED_CATEGORIZATION' | 'TIMESHEET_PAYROLL',
        sourceType: (body.source_type as 'BILL' | 'BANK_TXN' | 'TIMESHEET' | 'MANUAL') ?? 'MANUAL',
        sourceRef: (body.source_ref as string) ?? null,
        memo: (body.memo as string) ?? null,
        routing: { vendorId: (body.vendor_id as string) ?? null, accountNumber: (body.account_number as string) ?? null, sourceType: (body.source_type as string) ?? null },
      });
      return NextResponse.json({ ok: true, ...res });
    }
    if (action === 'approve') {
      return NextResponse.json({ ok: true, ...(await approveAttribution(supabase, orgId, String(body.id), userId)) });
    }
    if (action === 'void') {
      return NextResponse.json({ ok: true, ...(await voidAttribution(supabase, orgId, String(body.id), String(body.reason ?? 'Voided'))) });
    }
    if (action === 'override') {
      return NextResponse.json({ ok: true, ...(await overrideApprover(supabase, orgId, String(body.id), body.approver_type as 'ACCOUNTING' | 'RESPONSIBLE_PARTY' | 'PM_LEADER', (body.approver_ref as string) ?? null)) });
    }
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Action failed' }, { status: 500 });
  }
}
