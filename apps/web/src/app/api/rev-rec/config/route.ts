export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { hasModule } from '@/lib/services/entitlements';
import { z } from 'zod';

export const REV_REC_METHODS = [
  { value: 'PCT_COMPLETE', label: 'POC — physical % complete', poc: true },
  { value: 'PCT_COSTS_INCURRED', label: 'POC — cost-to-cost', poc: true },
  { value: 'COMPLETED_CONTRACT', label: 'Completed contract', poc: false },
  { value: 'MILESTONE', label: 'Milestone / point-in-time', poc: false },
  { value: 'POINT_OF_SALE', label: 'Point of sale', poc: false },
  { value: 'AS_BILLED', label: 'Billing-based', poc: false },
  { value: 'RATABLY', label: 'Straight-line / ratable', poc: false },
  { value: 'SUBSCRIPTION', label: 'Subscription (ratable)', poc: false },
  { value: 'CASH', label: 'Cash', poc: false },
] as const;

const METHOD_VALUES = REV_REC_METHODS.map((m) => m.value) as [string, ...string[]];

/** GET /api/rev-rec/config — per-company default + job_type map, plus whether Projects feeds inputs. */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const projectsEntitled = await hasModule(supabase, orgId, 'projects');

  const { data: locations } = await supabase
    .schema('core').from('locations')
    .select('id, name, short_code, rev_rec_method')
    .eq('is_active', true)
    .order('name');

  const { data: maps } = await supabase
    .from('rev_rec_method_map')
    .select('id, location_id, job_type, method')
    .eq('org_id', orgId)
    .order('job_type');

  const companies = (locations ?? []).map((l) => ({
    locationId: (l as { id: string }).id,
    name: (l as { name: string }).name,
    shortCode: (l as { short_code: string }).short_code,
    defaultMethod: (l as { rev_rec_method: string | null }).rev_rec_method ?? 'PCT_COSTS_INCURRED',
    map: (maps ?? []).filter((m) => (m as { location_id: string }).location_id === (l as { id: string }).id)
      .map((m) => ({ id: (m as { id: string }).id, jobType: (m as { job_type: string }).job_type, method: (m as { method: string }).method })),
  }));

  return NextResponse.json({
    methods: REV_REC_METHODS,
    projectsEntitled,
    inputMode: projectsEntitled ? 'AUTO_FED' : 'DIRECT_ENTRY',
    companies,
  });
}

// POST — set a company default, or upsert a job_type→method rule.
const postSchema = z.union([
  z.object({ kind: z.literal('default'), location_id: z.string().uuid(), method: z.enum(METHOD_VALUES) }),
  z.object({ kind: z.literal('map'), location_id: z.string().uuid(), job_type: z.string().min(1).max(100), method: z.enum(METHOD_VALUES) }),
]);

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = postSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 422 });
  const body = parsed.data;

  if (body.kind === 'default') {
    const { error } = await supabase.schema('core').from('locations').update({ rev_rec_method: body.method }).eq('id', body.location_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const { error } = await supabase.from('rev_rec_method_map').upsert({
    org_id: orgId, location_id: body.location_id, job_type: body.job_type, method: body.method, updated_at: new Date().toISOString(),
  }, { onConflict: 'org_id,location_id,job_type' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// DELETE /api/rev-rec/config?id=<map rule id>
export async function DELETE(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const { error } = await supabase.from('rev_rec_method_map').delete().eq('org_id', orgId).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
