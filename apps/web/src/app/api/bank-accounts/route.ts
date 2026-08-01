export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolveOrgId } from '@/lib/posting/lifecycle';

/**
 * GET /api/bank-accounts
 *   -> connected bank accounts (Plaid-linked) with their entity + current GL
 *      account, plus the GL options for re-selection. Used by the in-feed
 *      "manage accounts" panel to rename / reselect GL.
 *   Core-schema location names are stitched in JS (no cross-schema embed).
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
  try {
    const orgId = await resolveOrgId(db, claimOrgId);

    const { data: accts, error } = await db
      .from('bank_accounts')
      .select('id, account_name, account_mask, account_type, location_id, account_id, is_active, plaid_account_id')
      .eq('org_id', orgId)
      .not('plaid_account_id', 'is', null)
      .eq('is_active', true)
      .order('account_name');
    if (error) throw new Error(error.message);

    const rows = accts ?? [];
    const locIds = [...new Set(rows.map((r) => r.location_id).filter(Boolean))] as string[];
    const glIds = [...new Set(rows.map((r) => r.account_id).filter(Boolean))] as string[];

    const [locsRes, glNamesRes, glOptsRes] = await Promise.all([
      locIds.length
        ? db.schema('core').from('locations').select('id, name').in('id', locIds)
        : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
      glIds.length
        ? db.from('accounts').select('id, account_number, name').in('id', glIds)
        : Promise.resolve({ data: [] as Array<{ id: string; account_number: string; name: string }> }),
      db.from('accounts')
        .select('id, account_number, name, account_type, company_location_id')
        .eq('org_id', orgId)
        .eq('account_type', 'ASSET')
        .eq('is_active', true)
        .order('account_number'),
    ]);

    const locById = new Map((locsRes.data ?? []).map((l) => [l.id, l.name]));
    const glById = new Map((glNamesRes.data ?? []).map((g) => [g.id, g]));

    const accounts = rows.map((r) => ({
      id: r.id,
      label: r.account_name,
      mask: r.account_mask,
      type: r.account_type,
      locationId: r.location_id,
      locationName: locById.get(r.location_id) ?? 'Entity',
      glAccountId: r.account_id,
      glAccountLabel: (() => {
        const g = glById.get(r.account_id);
        return g ? `${g.account_number} · ${g.name}` : '—';
      })(),
    }));

    return NextResponse.json({ ok: true, accounts, glOptions: glOptsRes.data ?? [] });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
