export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getTierPolicy, scoreToTier } from '@/lib/trust/score-tier';
import { compositeMatchScore } from '@/lib/services/reconciliation-match';
import { suggestAccountForVendor } from '@/lib/learning/vendor-memory';

/**
 * GET /api/bank-feed/[id]/insight
 *
 * Read-only auto-match insight for one bank transaction — the "why did / didn't
 * this auto-approve" surface for the edit panel. Returns:
 *   - autoApprove: the confidence-tier evaluation against the org's real policy
 *     (confidence >= auto threshold AND amount <= cap AND trusted vendor), with a
 *     per-check breakdown so the UI can show exactly which condition blocked it.
 *   - match: the documented composite score (Vendor 40% + Amount 40% + Date 20%)
 *     of this line against the bill it's matched to, when it settles one.
 *   - topAccounts: the top-N GL accounts this vendor is usually coded to
 *     (derived live from approved history — proposes only).
 *
 * Nothing is mutated. RLS-scoped client; org enforced.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: txn, error } = await supabase
    .from('bank_transactions')
    .select(
      'id, description, amount_cents, transaction_date, ai_confidence, ai_vendor_id, final_vendor_id, match_type, match_confidence, matched_bill_id',
    )
    .eq('id', id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });

  const amountCents = Math.abs(Number(txn.amount_cents));
  const confidence = txn.ai_confidence == null ? null : Number(txn.ai_confidence);
  const vendorId = (txn.final_vendor_id as string | null) ?? (txn.ai_vendor_id as string | null);

  // ---- Vendor trust ("trusted vendor" = vendors.auto_approve) ----
  let trustedVendor: boolean | null = null;
  if (vendorId) {
    const { data: ven } = await supabase
      .schema('core')
      .from('vendors')
      .select('auto_approve')
      .eq('org_id', orgId)
      .eq('id', vendorId)
      .maybeSingle<{ auto_approve: boolean | null }>();
    trustedVendor = ven ? !!ven.auto_approve : null;
  }

  // ---- Auto-approve evaluation against the org's real policy ----
  const policy = await getTierPolicy(supabase, orgId);
  const effConfidence = confidence ?? 0;
  // trustedVendor is only a hard block when EXPLICITLY false; unknown (no vendor)
  // doesn't force-block here, mirroring scoreToTier's contract.
  const tierResult = scoreToTier(
    { confidence: effConfidence, amountCents, trustedVendor: trustedVendor === false ? false : undefined },
    policy,
  );
  const confidenceOk = effConfidence >= policy.autoThreshold;
  const amountOk = policy.autoMaxCents == null || amountCents <= policy.autoMaxCents;
  // Per the Business Rule, a positively-trusted vendor is required to auto-approve.
  const vendorTrusted = trustedVendor === true;

  const autoApprove = {
    eligible: tierResult.tier === 'auto' && vendorTrusted,
    tier: tierResult.tier,
    reason: tierResult.reason,
    confidence,
    amountCents,
    autoThreshold: policy.autoThreshold,
    autoMaxCents: policy.autoMaxCents,
    trustedVendor,
    checks: {
      confidenceOk,
      amountOk,
      vendorTrusted,
    },
  };

  // ---- Composite match breakdown vs the settled bill (if any) ----
  let match: {
    breakdown: ReturnType<typeof compositeMatchScore> | null;
    candidateLabel: string | null;
    matchType: string | null;
    matchConfidence: number | null;
  } = {
    breakdown: null,
    candidateLabel: null,
    matchType: (txn.match_type as string | null) ?? null,
    matchConfidence: txn.match_confidence == null ? null : Number(txn.match_confidence),
  };

  if (txn.match_type === 'BILL_PAYMENT' && txn.matched_bill_id) {
    const { data: bill } = await supabase
      .from('bills')
      .select('id, bill_number, bill_date, total_cents, vendor_id')
      .eq('id', txn.matched_bill_id as string)
      .maybeSingle<{ id: string; bill_number: string | null; bill_date: string; total_cents: number; vendor_id: string }>();
    if (bill) {
      // Prefer the bill's vendor name as the candidate text; fall back to number.
      let vendorName: string | null = null;
      const { data: bven } = await supabase
        .schema('core')
        .from('vendors')
        .select('name')
        .eq('org_id', orgId)
        .eq('id', bill.vendor_id)
        .maybeSingle<{ name: string }>();
      vendorName = bven?.name ?? null;
      const candidateText = vendorName ?? bill.bill_number ?? '';
      match = {
        breakdown: compositeMatchScore({
          txnText: txn.description as string,
          txnAmountCents: amountCents,
          txnDate: txn.transaction_date as string,
          candidateText,
          candidateAmountCents: Math.abs(Number(bill.total_cents)),
          candidateDate: bill.bill_date,
        }),
        candidateLabel: bill.bill_number ? `Bill #${bill.bill_number}` : (vendorName ?? 'Matched bill'),
        matchType: 'BILL_PAYMENT',
        matchConfidence: match.matchConfidence,
      };
    }
  }

  // ---- Top-N GL accounts for this vendor (proposes only) ----
  let topAccounts: Array<{
    accountId: string;
    accountNumber: string | null;
    accountName: string | null;
    count: number;
    total: number;
    share: number;
  }> = [];
  if (vendorId) {
    const memory = await suggestAccountForVendor(supabase, {
      orgId,
      vendorId,
      amountCents,
    });
    topAccounts = memory.suggestions.slice(0, 3).map((s) => ({
      accountId: s.accountId,
      accountNumber: s.accountNumber,
      accountName: s.accountName,
      count: s.count,
      total: s.total,
      share: s.share,
    }));
  }

  return NextResponse.json({ autoApprove, match, topAccounts });
}
