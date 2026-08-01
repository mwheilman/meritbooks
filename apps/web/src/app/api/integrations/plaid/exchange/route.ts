export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import { completePlaidLink } from '@/lib/money/plaid-feed';

/**
 * POST /api/integrations/plaid/exchange
 *   { public_token }
 *   -> exchanges for an access token, registers the connection (Vault), records
 *      the Item, upserts bank accounts, and runs a first transaction sync.
 */
const schema = z.object({
  public_token: z.string().min(10).max(2048),
  location_id: z.string().uuid(),
});

export async function POST(request: Request) {
  const a = await auth().catch(() => null);
  const userId = (a as { userId?: string | null } | null)?.userId ?? null;
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  // Operational org = the VERIFIED `org_id` claim (matches RLS get_org_id());
  // first-org lookup stays only as a transitional fallback when no claim.
  const claimOrgId =
    typeof (a?.sessionClaims as Record<string, unknown> | undefined)?.org_id === 'string'
      ? ((a!.sessionClaims as Record<string, unknown>).org_id as string)
      : null;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });

  const supabase = createAdminSupabase();
  try {
    const orgId = await resolveOrgId(supabase, claimOrgId);
    const linked = await completePlaidLink(supabase, orgId, {
      publicToken: parsed.data.public_token,
      connectedBy: userId,
      locationId: parsed.data.location_id,
    });
    // Do NOT sync yet — accounts are staged and have no GL/entity mapping, so
    // there is nowhere to attach transactions. The first sync runs after the
    // user maps accounts (see the map route).
    return NextResponse.json({ ok: true, linked });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
