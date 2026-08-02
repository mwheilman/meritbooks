export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import {
  runThreeWayMatch,
  toMatchConfidence,
  THREE_WAY_MATCH_FEATURE,
  type PoLineInput,
  type BillLineInput,
} from '@/lib/procurement/three-way-match';

/**
 * 3-WAY MATCH: link a bill to this PO, run the ordered/received/billed match, and
 * store the verdict on the bill↔PO link.
 *
 *   • CLEAN  → the link is MATCHED. A human may then approve/pay the bill through
 *              the normal AP flow. This route NEVER pays.
 *   • MISMATCH → the link is EXCEPTION and a PROPOSED row is written to
 *              public.ai_decisions (feature THREE_WAY_MATCH). The existing
 *              /exceptions queue folds PROPOSED ai_decisions in, so a human reviews
 *              the over-bill / over-receipt / price-variance before any payment.
 *
 * Idempotent per (bill, PO): re-running updates the same link + reuses/refreshes its
 * exception. Advances each PO line's billed_qty + the PO billed-value roll-up.
 */

const matchSchema = z.object({
  bill_id: z.string().uuid(),
  /** Optional price tolerance override as a percent (e.g. 2 for 2%). */
  price_tolerance_pct: z.number().min(0).max(100).optional(),
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'bills', 'create');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = matchSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const poId = params.id;
  const { bill_id: billId, price_tolerance_pct } = parsed.data;

  // Load the PO, its lines, the bill, and its lines (all RLS-scoped to the org).
  const { data: po } = await supabase
    .from('purchase_orders')
    .select('id, po_number, location_id, billed_total_cents')
    .eq('id', poId)
    .maybeSingle();
  if (!po) return NextResponse.json({ error: 'Purchase order not found', code: 'PO_NOT_FOUND' }, { status: 404 });

  const { data: bill } = await supabase
    .from('bills')
    .select('id, bill_number, total_cents')
    .eq('id', billId)
    .maybeSingle();
  if (!bill) return NextResponse.json({ error: 'Bill not found', code: 'BILL_NOT_FOUND' }, { status: 404 });

  const { data: poLinesRaw } = await supabase
    .from('purchase_order_lines')
    .select('id, description, account_id, item_id, quantity, unit_cost_cents, received_qty, billed_qty')
    .eq('po_id', poId)
    .order('line_number');
  const { data: billLinesRaw } = await supabase
    .from('bill_lines')
    .select('id, description, account_id, item_id, quantity, unit_cost_cents, amount_cents')
    .eq('bill_id', billId)
    .order('line_number');

  const poLines: PoLineInput[] = (poLinesRaw ?? []).map((l) => ({
    id: l.id as string,
    description: (l.description as string) ?? null,
    accountId: (l.account_id as string) ?? null,
    itemId: (l.item_id as string) ?? null,
    orderedQty: Number(l.quantity),
    unitCostCents: Number(l.unit_cost_cents),
    receivedQty: Number(l.received_qty),
  }));
  const billLines: BillLineInput[] = (billLinesRaw ?? []).map((l) => ({
    id: l.id as string,
    description: (l.description as string) ?? null,
    accountId: (l.account_id as string) ?? null,
    itemId: (l.item_id as string) ?? null,
    billedQty: Number(l.quantity),
    unitCostCents: Number(l.unit_cost_cents),
    amountCents: Number(l.amount_cents),
  }));

  const result = runThreeWayMatch({
    poLines,
    billLines,
    tolerance: price_tolerance_pct != null ? { pricePct: price_tolerance_pct / 100 } : undefined,
  });

  const isException = result.verdict === 'EXCEPTION';
  const nowIso = new Date().toISOString();

  // On a mismatch, raise (or refresh) a PROPOSED ai_decisions exception so a human
  // reviews it on /exceptions. Confidence = engine certainty that this IS an
  // exception (higher $ at risk / clearer flags → higher). We keep it simple and
  // deterministic: a firm 0.9 for a real mismatch.
  let exceptionDecisionId: string | null = null;
  if (isException) {
    // Reuse an existing open exception for this (bill, PO) if one is present.
    const { data: existing } = await supabase
      .from('ai_decisions')
      .select('id')
      .eq('feature', THREE_WAY_MATCH_FEATURE)
      .eq('status', 'PROPOSED')
      .contains('proposed_output', { bill_id: billId, po_id: poId })
      .maybeSingle();

    const proposedOutput = {
      control: '3WM',
      bill_id: billId,
      po_id: poId,
      po_number: po.po_number,
      bill_number: bill.bill_number,
      verdict: result.verdict,
      flags: result.flags,
      amount_at_risk_cents: result.amountAtRiskCents,
      totals: result.totals,
      lines: result.lines,
      reasons: result.reasons,
    };

    if (existing?.id) {
      await supabase
        .from('ai_decisions')
        .update({
          input_summary: result.summary,
          proposed_output: proposedOutput,
          confidence: toMatchConfidence(0.9),
          reasoning: result.reasons.join(' '),
        })
        .eq('id', existing.id);
      exceptionDecisionId = existing.id as string;
    } else {
      const { data: inserted } = await supabase
        .from('ai_decisions')
        .insert({
          org_id: orgId,
          location_id: (po.location_id as string) ?? null,
          feature: THREE_WAY_MATCH_FEATURE,
          input_summary: result.summary,
          proposed_output: proposedOutput,
          confidence: toMatchConfidence(0.9),
          reasoning: result.reasons.join(' '),
          clarifying_question:
            'Approve the variance and pay anyway, correct the bill/PO, or reject the bill?',
          status: 'PROPOSED',
          created_by_user: userId,
        })
        .select('id')
        .single();
      exceptionDecisionId = (inserted?.id as string) ?? null;
    }
  }

  // Upsert the bill↔PO link with the verdict.
  const linkRow = {
    org_id: orgId,
    bill_id: billId,
    po_id: poId,
    match_status: isException ? 'EXCEPTION' : 'MATCHED',
    match_result: result,
    exception_decision_id: exceptionDecisionId,
    matched_by_user: userId,
    matched_at: nowIso,
  };
  const { error: linkErr } = await supabase
    .from('bill_po_links')
    .upsert(linkRow, { onConflict: 'org_id,bill_id,po_id' });
  if (linkErr) {
    return NextResponse.json({ error: linkErr.message, code: 'LINK_FAILED' }, { status: 500 });
  }

  // Advance PO line billed_qty + PO billed-value roll-up from the matched lines.
  let billedValueDelta = 0;
  for (const line of result.lines) {
    if (!line.poLineId) continue;
    const poLine = poLines.find((p) => p.id === line.poLineId);
    if (!poLine) continue;
    billedValueDelta += line.billedAmountCents;
    await supabase
      .from('purchase_order_lines')
      .update({ billed_qty: line.billedQty })
      .eq('id', line.poLineId);
  }
  await supabase
    .from('purchase_orders')
    .update({ billed_total_cents: billedValueDelta })
    .eq('id', poId);

  await logHumanAction(supabase, userId, orgId, {
    action: 'three_way_match.run',
    subjectTable: 'bill_po_links',
    subjectId: billId,
    summary: `3-way match ${po.po_number} ↔ bill ${bill.bill_number ?? billId}: ${result.verdict}`,
    metadata: { verdict: result.verdict, flags: result.flags, amount_at_risk_cents: result.amountAtRiskCents },
  });

  return NextResponse.json({
    verdict: result.verdict,
    match_status: linkRow.match_status,
    exception_decision_id: exceptionDecisionId,
    amount_at_risk_cents: result.amountAtRiskCents,
    result,
  });
}
