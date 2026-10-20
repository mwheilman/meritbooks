export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { requirePermission } from '@/lib/rbac/require-permission';
import { syncAllPlaidItems } from '@/lib/money/plaid-feed';

/**
 * GET  /api/integrations/plaid/sync
 *   -> connection status: items, health, last sync, accounts linked.
 *
 * POST /api/integrations/plaid/sync
 *   -> runs an incremental sync of all Items and returns a summary.
 *
 * ORG RESOLUTION (06 §L.3 L2): the tenant comes from requireAuthedContext() — the same
 * caller-org resolution every other route uses (the explicit `org_id` claim OR Clerk's
 * native active-org `o.id`, mapped to the Books tenant). These routes previously read
 * only `sessionClaims.org_id`, so a session carrying the org as `o.id` 500'd with
 * "No organization claim on request". An unresolved org now fails CLOSED with 400.
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // Status read runs AS THE USER (RLS) and is also explicitly org-scoped.
  const { data: items, error } = await supabase
    .from('plaid_items')
    .select('id, plaid_item_id, institution_name, status, status_detail, last_synced_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

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
}

export async function POST() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { userId, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // Authorize — a sync imports bank transactions into the feed (it writes the org's
  // books-of-entry queue), so it carries the bank-feed edit gate. Fails closed (403).
  const guard = await requirePermission(userId, 'bank_feed', 'edit');
  if (!guard.ok) return guard.response;

  // The sync reads Plaid access tokens, which only the service role may see. The org is
  // the caller's resolved tenant (never a fallback), and syncAllPlaidItems scopes to it.
  const admin = createAdminSupabase();
  try {
    const summary = await syncAllPlaidItems(admin, orgId);
    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
