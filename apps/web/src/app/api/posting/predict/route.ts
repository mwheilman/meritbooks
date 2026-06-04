export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import { predictException } from '@/lib/posting/exception-predictor';

/**
 * POST /api/posting/predict
 *   { location_id, account_id, amount_cents, description?, side? }
 * Returns the deterministic, advisory exception prediction (capitalize / prepaid /
 * deferred-revenue / expense) for a categorized line, using the company's policy
 * thresholds. The caller (UI or AI JE engine) decides whether to act on it.
 */
export async function POST(request: Request) {
  await auth().catch(() => null);

  let body: { location_id?: string; account_id?: string; amount_cents?: number; description?: string; side?: 'expense' | 'revenue' };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.location_id || !body.account_id || typeof body.amount_cents !== 'number') {
    return NextResponse.json({ error: 'location_id, account_id, and amount_cents are required' }, { status: 422 });
  }

  const supabase = createAdminSupabase();
  try {
    const orgId = await resolveOrgId(supabase);
    const prediction = await predictException(supabase, {
      orgId,
      locationId: body.location_id,
      accountId: body.account_id,
      amountCents: body.amount_cents,
      description: body.description,
      side: body.side,
    });
    return NextResponse.json({ ok: true, prediction });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'prediction failed' }, { status: 500 });
  }
}
