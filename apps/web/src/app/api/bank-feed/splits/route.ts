export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import {
  saveSplitDraftSchema,
  splitQuerySchema,
  type SaveSplitDraftInput,
  type SplitQuery,
} from '@/lib/validations/bank-splits';
import { loadFeedTxn, loadSplitRows, saveDraftSplit, suggestSplit, SplitError } from '@/lib/bank/splits/service';

/**
 * GET /api/bank-feed/splits?transaction_id=
 * The split state of one bank / card feed line (FPB-bank-feed-splits): its saved lines
 * (DRAFT or POSTED) and — when unsplit — a suggestion from a remembered rule or the
 * vendor's last split. Read-only; RLS-scoped client.
 */
export const GET = apiQueryHandler(splitQuerySchema, async (params: SplitQuery, ctx) => {
  const guard = await requirePermission(ctx.userId, 'bank_feed', 'view');
  if (!guard.ok) return guard.response;
  const orgId = ctx.orgId;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const txn = await loadFeedTxn(ctx.supabase, orgId, params.transaction_id);
  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });

  const rows = await loadSplitRows(ctx.supabase, orgId, txn.id);
  const status = rows.length === 0 ? 'NONE' : rows.some((r) => r.status === 'POSTED') ? 'POSTED' : 'DRAFT';
  const vendorId = txn.final_vendor_id ?? txn.ai_vendor_id;
  const suggestion = status === 'NONE' && txn.status !== 'POSTED' ? await suggestSplit(ctx.supabase, orgId, txn, vendorId) : null;
  const billSettlement = txn.amount_cents < 0 && txn.match_type === 'BILL_PAYMENT' && !!txn.matched_bill_id;

  // Labels for every account the grid will show (saved lines + the suggestion).
  const accountIds = Array.from(new Set([...rows.map((r) => r.account_id), ...(suggestion?.lines ?? []).map((l) => l.account_id)]));
  const accounts: Record<string, { id: string; account_number: string; name: string; account_type: string }> = {};
  if (accountIds.length > 0) {
    const { data: accts } = await ctx.supabase
      .from('accounts')
      .select('id, account_number, name, account_type')
      .eq('org_id', orgId)
      .in('id', accountIds);
    for (const a of (accts ?? []) as Array<{ id: string; account_number: string; name: string; account_type: string }>) accounts[a.id] = a;
  }

  return NextResponse.json({
    transaction: {
      id: txn.id,
      amount_cents: txn.amount_cents,
      status: txn.status,
      location_id: txn.location_id,
      splittable: !billSettlement,
    },
    status,
    lines: rows,
    suggestion,
    accounts,
  });
});

/**
 * POST /api/bank-feed/splits
 * Save (replace) the draft split of an unposted feed line — `lines: []` unsplits it.
 * Validated exactly as approve validates it (Σ = total, in-org ids, company rules), but
 * nothing is posted. Posted lines are refused: edit them through reversal.
 */
export const POST = apiHandler(saveSplitDraftSchema, async (body: SaveSplitDraftInput, ctx) => {
  const guard = await requirePermission(ctx.userId, 'bank_feed', 'edit');
  if (!guard.ok) return guard.response;
  const orgId = ctx.orgId;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const txn = await loadFeedTxn(ctx.supabase, orgId, body.transaction_id);
  if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });

  try {
    const res = await saveDraftSplit(ctx.supabase, { orgId, txn, lines: body.lines, splitRuleId: body.split_rule_id ?? null });
    await logHumanAction(ctx.supabase, ctx.userId, orgId, {
      action: res.lines > 0 ? 'bankfeed.split.save' : 'bankfeed.split.clear',
      subjectTable: 'bank_transactions',
      subjectId: txn.id,
      summary: res.lines > 0 ? `Saved a ${res.lines}-line split (not posted)` : 'Removed the split (unsplit)',
      locationId: txn.location_id,
    });
    return NextResponse.json({ success: true, lines: res.lines });
  } catch (e) {
    if (e instanceof SplitError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
});
