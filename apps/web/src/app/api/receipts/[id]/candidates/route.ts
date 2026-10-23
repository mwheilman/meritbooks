export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { loadOpenCharges, rankCandidates } from '@/lib/receipts/match';
import { loadReceiptPolicyContext, mergeReceiptPolicy } from '@/lib/receipts/policy';

/**
 * GET /api/receipts/[id]/candidates — the open card charges this receipt could belong to,
 * scored (vendor 40 / amount 40 / date 20), best first. receipts:view. Every read is the
 * caller's RLS client, so only charges they can see are offered.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId, supabase } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'receipts', 'view', { route: '/api/receipts/[id]/candidates' });
  if (!guard.ok) return guard.response;

  const { data: rec } = await supabase
    .from('receipts')
    .select('id, location_id, vendor_name, amount_cents, receipt_date, card_assignment_id')
    .eq('org_id', orgId)
    .eq('id', params.id)
    .maybeSingle();
  if (!rec) return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
  const r = rec as { id: string; location_id: string; vendor_name: string | null; amount_cents: number | null; receipt_date: string | null; card_assignment_id: string | null };
  const pctx = await loadReceiptPolicyContext(supabase, orgId);
  const policy = mergeReceiptPolicy(pctx.rows, r.location_id);
  const charges = await loadOpenCharges(supabase, orgId, r.location_id, r.receipt_date, Math.max(policy.dateWindowDays, 14), new Date());
  const ranked = rankCandidates({ vendorName: r.vendor_name, amountCents: r.amount_cents != null ? Math.abs(Number(r.amount_cents)) : null, receiptDate: r.receipt_date }, charges, { ...policy, dateWindowDays: Math.max(policy.dateWindowDays, 14) }, r.card_assignment_id);
  // Also offer the closest charges by amount when nothing scores (a person may know better).
  const fallback = ranked.length
    ? []
    : charges
        .slice()
        .sort((a, b) => Math.abs(a.amountCents - Number(r.amount_cents ?? 0)) - Math.abs(b.amountCents - Number(r.amount_cents ?? 0)))
        .slice(0, 5)
        .map((c) => ({ charge: c, score: null }));
  return NextResponse.json({
    candidates: [...ranked.slice(0, 8).map((c) => ({ charge: c.charge, score: c.score })), ...fallback],
    autoMatchMin: policy.autoMatchMinScore,
    suggestMin: policy.suggestMinScore,
  });
}
