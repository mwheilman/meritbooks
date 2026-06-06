export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';
import { syncAllPlaidItems } from '@/lib/money/plaid-feed';

/**
 * GET  /api/integrations/plaid/sync
 *   -> connection status: items, health, last sync, accounts linked.
 *
 * POST /api/integrations/plaid/sync
 *   -> runs an incremental sync of all Items and returns a summary.
 */
export async function GET() {
  await auth().catch(() => null);
  const supabase = createAdminSupabase();
  try {
    const orgId = await resolveOrgId(supabase);
    const { data: items, error } = await supabase
      .from('plaid_items')
      .select('id, plaid_item_id, institution_name, status, status_detail, last_synced_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);

    const { count: accountCount } = await supabase
      .from('bank_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .not('plaid_account_id', 'is', null);

    return NextResponse.json({
      ok: true,
      items: items ?? [],
      accountCount: accountCount ?? 0,
      connected: (items ?? []).length > 0,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}

export async function POST() {
  const a = await auth().catch(() => null);
  const userId = (a as { userId?: string | null } | null)?.userId ?? null;
  if (!userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });

  const supabase = createAdminSupabase();
  try {
    const orgId = await resolveOrgId(supabase);
    const summary = await syncAllPlaidItems(supabase, orgId);
    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
