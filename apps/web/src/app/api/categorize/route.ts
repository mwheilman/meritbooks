export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { z } from 'zod';
import { suggestCategory } from '@/lib/services/categorization';

const schema = z.object({
  description: z.string().min(3).max(2000),
  amount_cents: z.number().int().nonnegative(),
  location_id: z.string().uuid().nullable().optional(),
});

async function resolveOrgId(supabase: ReturnType<typeof createAdminSupabase>): Promise<string | null> {
  const { data } = await supabase.schema('core').from('organizations').select('id').limit(1).single();
  return (data as { id: string } | null)?.id ?? null;
}

export async function POST(request: Request) {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();

  let raw: unknown;
  try { raw = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });

  const orgId = await resolveOrgId(supabase);
  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'AI is not configured (ANTHROPIC_API_KEY missing).' }, { status: 503 });

  const res = await suggestCategory(supabase, apiKey, {
    orgId,
    description: parsed.data.description,
    amountCents: parsed.data.amount_cents,
    locationId: parsed.data.location_id ?? null,
  });
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: res.budgetBlocked ? 402 : 502 });
  }

  // Flat approved COA for the UI (expense-account override + "paid from" picker).
  const { data: accts } = await supabase
    .from('accounts')
    .select('id, account_number, name, account_type')
    .eq('org_id', orgId).eq('is_active', true).eq('approval_status', 'APPROVED')
    .order('account_number');

  return NextResponse.json({ suggestion: res.suggestion, accounts: accts ?? [] });
}
