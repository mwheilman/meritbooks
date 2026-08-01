export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';

/**
 * GET /api/integrations/plaid/diag
 * Read-only diagnostic of the Plaid bank-feed pipeline state for this tenant.
 * Surfaces every step's counts + any error text so we can see exactly where a
 * connect/sync stopped, without server log access. Safe: no writes, no secrets.
 */
export async function GET() {
  const a = await auth().catch(() => null);
  // Operational org = the VERIFIED `org_id` claim (matches RLS get_org_id());
  // first-org lookup stays only as a transitional fallback when no claim.
  const claimOrgId =
    typeof (a?.sessionClaims as Record<string, unknown> | undefined)?.org_id === 'string'
      ? ((a!.sessionClaims as Record<string, unknown>).org_id as string)
      : null;
  const db = createAdminSupabase();
  const out: Record<string, unknown> = {};

  try {
    const orgId = await resolveOrgId(db, claimOrgId);
    out.orgId = orgId;

    // 1. Locations (need at least one to attach a bank account)
    const loc = await db.schema('core').from('locations').select('id, name, org_id').eq('org_id', orgId);
    out.locations = { count: loc.data?.length ?? 0, error: loc.error?.message ?? null, sample: loc.data?.slice(0, 3) ?? [] };

    // 2. Cash GL account resolution inputs
    const roles = await db.from('account_roles').select('role_key, account_id').eq('org_id', orgId).in('role_key', ['operating_bank', 'cash']);
    out.cashRoles = { count: roles.data?.length ?? 0, error: roles.error?.message ?? null, rows: roles.data ?? [] };

    const assets = await db.from('accounts').select('id, account_number, account_type').eq('org_id', orgId).eq('account_type', 'ASSET').order('account_number').limit(3);
    out.assetAccounts = { count: assets.data?.length ?? 0, error: assets.error?.message ?? null, sample: assets.data ?? [] };

    // 3. Provider connections (BANK_FEED)
    const conns = await db.schema('core').from('provider_connections').select('id, capability, provider, status, secret_ref, account_handle').eq('org_id', orgId).eq('capability', 'BANK_FEED');
    out.connections = {
      count: conns.data?.length ?? 0,
      error: conns.error?.message ?? null,
      rows: (conns.data ?? []).map((c: Record<string, unknown>) => ({ ...c, secret_ref: c.secret_ref ? 'present' : null })),
    };

    // 4. Plaid items
    const items = await db.from('plaid_items').select('id, plaid_item_id, institution_name, sync_cursor, last_synced_at, status, status_detail').eq('org_id', orgId);
    out.plaidItems = { count: items.data?.length ?? 0, error: items.error?.message ?? null, rows: items.data ?? [] };

    // 5. Bank accounts (the missing piece, per the UI)
    const ba = await db.from('bank_accounts').select('id, account_name, account_type, plaid_account_id, location_id, current_balance_cents, is_active').eq('org_id', orgId);
    out.bankAccounts = { count: ba.data?.length ?? 0, error: ba.error?.message ?? null, rows: ba.data ?? [] };

    // 6. Bank transactions
    const txn = await db.from('bank_transactions').select('id', { count: 'exact', head: true }).eq('org_id', orgId).not('plaid_transaction_id', 'is', null);
    out.plaidTransactions = { count: txn.count ?? 0, error: txn.error?.message ?? null };

    // 7. Can we read the stored secret back? (the step that failed before 047)
    const firstConn = conns.data?.[0] as { secret_ref?: string | null } | undefined;
    if (firstConn?.secret_ref) {
      const sec = await db.rpc('read_provider_secret', { p_ref: firstConn.secret_ref });
      out.vaultRead = { ok: !sec.error && !!sec.data, error: sec.error?.message ?? null, tokenLooksValid: typeof sec.data === 'string' && (sec.data as string).startsWith('access-') };
    } else {
      out.vaultRead = { ok: false, error: 'no secret_ref on connection' };
    }

    return NextResponse.json({ ok: true, diag: out });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'failed', partial: out }, { status: 500 });
  }
}
