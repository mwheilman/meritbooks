export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/server';
import { completePlaidLink } from '@/lib/money/plaid-feed';
import { requirePermission } from '@/lib/rbac/require-permission';

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
  // Caller + tenant via the app-wide resolver (06 §L.3 L2: explicit `org_id` claim OR
  // Clerk's native `o.id`); an unresolved org fails CLOSED with 400.
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { userId, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  // Authorize — exchanging the public token registers the bank connection
  // (Vault secret) and upserts bank accounts; same gate as payments/connect.
  const guard = await requirePermission(userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;

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
