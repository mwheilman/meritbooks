export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';
import { TEXT_SLOTS } from '@/lib/invoices/resolve-invoice-text';

type Supa = ReturnType<typeof createAdminSupabase>;
async function getOrgId(supabase: Supa): Promise<string | null> {
  const { data } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

const SCOPES = ['CUSTOMER', 'JOB', 'INVOICE_TYPE', 'INVOICE'] as const;

/**
 * GET /api/invoice-text?scope=CUSTOMER&ref=<id> — current text overrides set at
 * one scope (the per-customer / per-job / per-invoice-type / per-invoice values).
 */
export async function GET(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const orgId = await getOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const scope = searchParams.get('scope');
  const ref = searchParams.get('ref');
  if (!scope || !ref || !SCOPES.includes(scope as typeof SCOPES[number])) {
    return NextResponse.json({ error: 'scope and ref are required' }, { status: 400 });
  }

  const { data } = await supabase
    .from('invoice_text_overrides')
    .select('slot, value')
    .eq('org_id', orgId).eq('scope', scope).eq('scope_ref', ref);

  const values: Record<string, string> = {};
  for (const r of data ?? []) values[(r as { slot: string }).slot] = (r as { value: string }).value;
  return NextResponse.json({ scope, ref, slots: TEXT_SLOTS, values });
}

const putSchema = z.object({
  scope: z.enum(SCOPES),
  ref: z.string().min(1),
  slot: z.enum(TEXT_SLOTS),
  value: z.string().max(2000),
});

/**
 * PUT /api/invoice-text — set (or clear) one text slot at one scope. Empty value
 * clears the override so it falls back up the cascade.
 */
export async function PUT(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  const orgId = await getOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const parsed = putSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 422 });
  const { scope, ref, slot, value } = parsed.data;

  if (value.trim() === '') {
    await supabase.from('invoice_text_overrides').delete()
      .eq('org_id', orgId).eq('scope', scope).eq('scope_ref', ref).eq('slot', slot);
    return NextResponse.json({ ok: true, cleared: true });
  }

  const { error } = await supabase.from('invoice_text_overrides').upsert({
    org_id: orgId, scope, scope_ref: ref, slot, value, updated_at: new Date().toISOString(),
  }, { onConflict: 'org_id,scope,scope_ref,slot' });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
