export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import { completePlaidLink, syncAllPlaidItems } from '@/lib/money/plaid-feed';

/**
 * POST /api/integrations/plaid/exchange
 *   { public_token }
 *   -> exchanges for an access token, registers the connection (Vault), records
 *      the Item, upserts bank accounts, and runs a first transaction sync.
 */
const schema = z.object({ public_token: z.string().min(10).max(2048) });

export async function POST(request: Request) {
  const a = await auth().catch(() => null);
  const userId = (a as { userId?: string | null } | null)?.userId ?? null;
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

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
    const orgId = await resolveOrgId(supabase);
    const linked = await completePlaidLink(supabase, orgId, {
      publicToken: parsed.data.public_token,
      connectedBy: userId,
    });
    // First sync immediately so the user sees transactions right away.
    const sync = await syncAllPlaidItems(supabase, orgId).catch(() => null);
    return NextResponse.json({ ok: true, linked, sync });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
