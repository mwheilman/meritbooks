export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  listPendingAccounts,
  mapPendingAccount,
  ignorePendingAccount,
  syncAllPlaidItems,
} from '@/lib/money/plaid-feed';
import { requirePermission } from '@/lib/rbac/require-permission';

/**
 * GET /api/integrations/plaid/map
 *   -> { pending: [...], entities: [...], glAccounts: [...] }
 *   Everything the mapping UI needs: the staged accounts awaiting assignment,
 *   the tenant's entities (locations), and the GL cash-account options.
 *
 * POST /api/integrations/plaid/map
 *   { action: 'map', pending_id, location_id, gl_account_id, label }  -> promote
 *   { action: 'ignore', pending_id }                                  -> ignore
 *   On a successful map, a sync is triggered so transactions import immediately.
 *
 * ORG RESOLUTION (06 §L.3 L2): the tenant comes from requireAuthedContext() — the same
 * caller-org resolution as the rest of the app (explicit `org_id` claim OR Clerk's
 * native `o.id`). An unresolved org fails CLOSED with 400 (it used to 500).
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  // Read-only: runs AS THE USER (RLS) and every query is explicitly org-scoped.
  const db = ctx.supabase;
  try {
    const [pending, entitiesRes, glRes] = await Promise.all([
      listPendingAccounts(db, orgId),
      db.schema('core').from('locations').select('id, name, short_code').eq('org_id', orgId).order('name'),
      db.from('accounts')
        .select('id, account_number, name, account_type, is_bank_account, company_location_id')
        .eq('org_id', orgId)
        .eq('account_type', 'ASSET')
        .eq('is_active', true)
        .order('account_number'),
    ]);

    return NextResponse.json({
      ok: true,
      pending,
      entities: entitiesRes.data ?? [],
      glAccounts: glRes.data ?? [],
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}

const mapSchema = z.object({
  action: z.literal('map'),
  pending_id: z.string().uuid(),
  gl_account_id: z.string().uuid(),
  label: z.string().min(1).max(120),
});
const ignoreSchema = z.object({ action: z.literal('ignore'), pending_id: z.string().uuid() });
const bodySchema = z.union([mapSchema, ignoreSchema]);

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { userId, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  // Authorize — mapping a linked bank account to an entity + GL cash account (or
  // ignoring it) decides where bank activity posts; accounting configuration.
  const guard = await requirePermission(userId, 'settings_acct', 'edit');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'Validation failed' }, { status: 422 });

  // Promotion + the follow-on sync touch Plaid access tokens → service role, scoped to
  // the caller's resolved tenant (never a fallback).
  const db = createAdminSupabase();
  try {
    if (parsed.data.action === 'ignore') {
      await ignorePendingAccount(db, orgId, parsed.data.pending_id);
      return NextResponse.json({ ok: true });
    }

    const result = await mapPendingAccount(db, orgId, {
      pendingId: parsed.data.pending_id,
      glAccountId: parsed.data.gl_account_id,
      label: parsed.data.label,
    });

    // Now that at least one account is mapped, pull transactions.
    const sync = await syncAllPlaidItems(db, orgId).catch(() => null);

    return NextResponse.json({ ok: true, bankAccountId: result.bankAccountId, sync });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
