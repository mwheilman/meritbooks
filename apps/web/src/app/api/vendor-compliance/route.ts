export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';
import {
  getVendorComplianceOverview,
  grantOverride,
  releaseOverride,
  runComplianceMaintenance,
} from '@/lib/services/vendor-compliance';

async function resolveOrgId(supabase: ReturnType<typeof createAdminSupabase>): Promise<string | null> {
  const { data } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

// ─── GET: vendor-compliance overview ──────────────────────────────────────────
export async function GET() {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const orgId = await resolveOrgId(supabase);
  if (!orgId) {
    return NextResponse.json({ rows: [], summary: { total: 0, onHold: 0, withOverride: 0, compliant: 0, blockedBalanceCents: 0 } });
  }
  const overview = await getVendorComplianceOverview(supabase, orgId);
  return NextResponse.json(overview);
}

// ─── POST: override grant / release / maintenance run ─────────────────────────
const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('grant_override'),
    vendor_id: z.string().uuid(),
    hold_type: z.enum(['ONE_TIME', 'TEMPORARY', 'PERMANENT']),
    reason: z.string().min(3).max(1000),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  z.object({
    action: z.literal('release_override'),
    override_id: z.string().uuid(),
    reason: z.string().min(3).max(1000),
  }),
  z.object({ action: z.literal('run_maintenance') }),
]);

export async function POST(request: Request) {
  const { userId } = await auth().catch(() => ({ userId: null as string | null }));
  const supabase = createAdminSupabase();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const k = issue.path.join('.') || '_root';
      (details[k] ??= []).push(issue.message);
    }
    return NextResponse.json({ error: 'Validation failed', details }, { status: 422 });
  }

  const orgId = await resolveOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const body = parsed.data;

  if (body.action === 'grant_override') {
    const res = await grantOverride(supabase, orgId, {
      vendorId: body.vendor_id,
      holdType: body.hold_type,
      reason: body.reason,
      endDate: body.end_date ?? null,
      actor: userId,
    });
    if (!res.success) return NextResponse.json({ error: res.error }, { status: 400 });
    return NextResponse.json({ override_id: res.overrideId }, { status: 201 });
  }

  if (body.action === 'release_override') {
    const res = await releaseOverride(supabase, orgId, body.override_id, body.reason, userId);
    if (!res.success) return NextResponse.json({ error: res.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  // run_maintenance
  const res = await runComplianceMaintenance(supabase, orgId);
  return NextResponse.json({ expired: res.expired, chased: res.chased });
}
