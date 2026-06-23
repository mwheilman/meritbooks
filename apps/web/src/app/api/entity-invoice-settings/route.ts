export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';

/**
 * Per-scope invoice cascade settings: authorized payment methods, card-surcharge
 * posture, and retainage opt-in. Set at CUSTOMER / JOB / LOCATION (entity); each
 * is nullable so it inherits down the cascade (invoice → job → customer → entity).
 * All three scopes share the same columns (added in migration 050), so one
 * endpoint serves them. Self-saving — independent of the create forms.
 */
const TABLE: Record<string, string> = { CUSTOMER: 'customers', JOB: 'jobs', LOCATION: 'locations' };

type Supa = ReturnType<typeof createAdminSupabase>;
async function orgIdOf(s: Supa) {
  const { data } = await s.schema('core').from('organizations').select('id').limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const { searchParams } = new URL(request.url);
  const scope = String(searchParams.get('scope') ?? '');
  const id = String(searchParams.get('id') ?? '');
  const table = TABLE[scope];
  if (!table || !id) return NextResponse.json({ error: 'scope and id required' }, { status: 400 });

  const { data, error } = await supabase
    .schema('core').from(table)
    .select('payment_methods_allowed, card_surcharge_enabled, retainage_enabled, default_retainage_pct')
    .eq('id', id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const r = (data as Record<string, unknown>) ?? {};
  return NextResponse.json({
    paymentMethods: (r.payment_methods_allowed as string[] | null) ?? null,
    cardSurcharge: (r.card_surcharge_enabled as boolean | null) ?? null,
    retainageEnabled: (r.retainage_enabled as boolean | null) ?? null,
    retainagePct: r.default_retainage_pct != null ? Number(r.default_retainage_pct) : null,
  });
}

const nullableBool = z.union([z.boolean(), z.null()]);
const putSchema = z.object({
  scope: z.enum(['CUSTOMER', 'JOB', 'LOCATION']),
  id: z.string().uuid(),
  payment_methods_allowed: z.union([z.array(z.enum(['CHECK', 'ACH', 'CARD'])), z.null()]),
  card_surcharge_enabled: nullableBool,
  retainage_enabled: nullableBool,
  default_retainage_pct: z.union([z.number().min(0).max(100), z.null()]),
});

export async function PUT(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const orgId = await orgIdOf(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const parsed = putSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 422 });
  const b = parsed.data;
  const table = TABLE[b.scope];

  const { error } = await supabase
    .schema('core').from(table)
    .update({
      payment_methods_allowed: b.payment_methods_allowed && b.payment_methods_allowed.length ? b.payment_methods_allowed : null,
      card_surcharge_enabled: b.card_surcharge_enabled,
      retainage_enabled: b.retainage_enabled,
      default_retainage_pct: b.default_retainage_pct,
    })
    .eq('id', b.id).eq('org_id', orgId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
