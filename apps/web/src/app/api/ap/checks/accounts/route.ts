export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { checkAccountsQuery } from '@/lib/validations/checks';
import { checkErrorResponse, requireCheckView } from '@/lib/ap/checks/route-support';
import { getCheckMailProvider } from '@/lib/ap/check-mail/provider';
import { checkAccountsForPicker } from '@/lib/ap/checks/check-accounts';

/**
 * GET /api/ap/checks/accounts — checking accounts a check can be drawn on (optionally one
 * company's), with each account's next number, setup state and outstanding count.
 * Retirement / HSA / investment / loan accounts that were linked as CHECKING are dropped
 * (lib/ap/checks/check-accounts); the account with a check-stock profile comes first.
 * checks:view. RLS + client scope through the caller's client; never returns MICR numbers.
 */
export const GET = apiQueryHandler(checkAccountsQuery, async (q, { userId, orgId, supabase }) => {
  const guard = await requireCheckView(userId);
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  try {
    let accQ = supabase
      .from('bank_accounts')
      .select('id, location_id, account_name, institution_name, account_mask, account_type, is_active')
      .eq('org_id', orgId)
      .eq('account_type', 'CHECKING')
      .eq('is_active', true)
      .order('account_name', { ascending: true });
    if (q.location_id) accQ = accQ.eq('location_id', q.location_id);
    const { data: accounts, error } = await accQ;
    if (error) throw new Error(error.message);
    const linked = (accounts ?? []) as Array<{ id: string; location_id: string; account_name: string; institution_name: string; account_mask: string | null; account_type: string; is_active: boolean }>;
    const candidateIds = linked.map((a) => a.id);
    const { data: profileRows, error: profErr } = candidateIds.length
      ? await supabase.from('check_stock_profiles').select('bank_account_id, layout, micr_set_at, signature_set_at, routing_mask, account_mask').eq('org_id', orgId).in('bank_account_id', candidateIds)
      : { data: [], error: null };
    if (profErr) throw new Error(profErr.message);
    const prof = new Map(((profileRows ?? []) as Array<{ bank_account_id: string; layout: string; micr_set_at: string | null; signature_set_at: string | null; account_mask: string | null }>).map((p) => [p.bank_account_id, p]));
    const withProfile = new Set(prof.keys());
    const rows = checkAccountsForPicker(linked, withProfile);
    const ids = rows.map((a) => a.id);
    const [seqs, outstanding] = ids.length
      ? await Promise.all([
          supabase.from('bank_check_sequences').select('bank_account_id, next_number').eq('org_id', orgId).in('bank_account_id', ids),
          supabase.from('ap_checks').select('bank_account_id, amount_cents').eq('org_id', orgId).in('bank_account_id', ids).in('status', ['PRINTED', 'ISSUED', 'MAILED']),
        ])
      : [{ data: [] }, { data: [] }];
    const seq = new Map(((seqs.data ?? []) as Array<{ bank_account_id: string; next_number: number }>).map((s) => [s.bank_account_id, Number(s.next_number)]));
    const out = new Map<string, { count: number; cents: number }>();
    for (const c of (outstanding.data ?? []) as Array<{ bank_account_id: string; amount_cents: number }>) {
      const o = out.get(c.bank_account_id) ?? { count: 0, cents: 0 };
      o.count += 1;
      o.cents += Number(c.amount_cents);
      out.set(c.bank_account_id, o);
    }
    return NextResponse.json({
      accounts: rows.map((a) => ({
        id: a.id,
        locationId: a.location_id,
        name: a.account_name,
        institution: a.institution_name,
        mask: a.account_mask,
        layout: prof.get(a.id)?.layout ?? 'VOUCHER_TOP',
        hasStockProfile: prof.has(a.id),
        hasMicr: !!prof.get(a.id)?.micr_set_at,
        hasSignature: !!prof.get(a.id)?.signature_set_at,
        nextNumber: seq.get(a.id) ?? 1001,
        outstandingCount: out.get(a.id)?.count ?? 0,
        outstandingCents: out.get(a.id)?.cents ?? 0,
      })),
      mail: getCheckMailProvider(orgId).status(),
    });
  } catch (e) {
    return checkErrorResponse(e, 'Could not load bank accounts.');
  }
});
