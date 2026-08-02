export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, type ApiContext } from '@/lib/api-handler';
import { proposeFromBill } from '@/lib/prepaid/propose';
import { proposeFromBillSchema, type ProposeFromBillBody } from '@/lib/prepaid/schema';

export const PREPAID_PROPOSE_FEATURE = 'PREPAID_SCHEDULE';

/**
 * POST /api/prepaid/propose — propose a prepaid amortization schedule from a BILL line.
 *
 * Deterministic (no model call): amount = the line total, expense account = the
 * line's account, start = the bill date, term = a sensible default the human
 * confirms; the prepaid-asset credit leg is resolved by role/name. Writes one
 * `ai_decisions` PROPOSED audit row and returns the proposal for the setup form to
 * pre-fill. Canon §3 — proposes only; nothing persists until the human confirms via
 * `POST /api/prepaid`. Gated on `journal_entries:create` (the confirm path is gated too).
 */
export const POST = apiHandler(
  proposeFromBillSchema,
  async (body: ProposeFromBillBody, ctx: ApiContext): Promise<NextResponse> => {
    if (!ctx.orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

    const proposal = await proposeFromBill(ctx.supabase, {
      billId: body.bill_id,
      billLineId: body.bill_line_id,
      termMonths: body.term_months,
    });
    if (!proposal) {
      return NextResponse.json({ error: 'Bill line not found in your organization', code: 'NOT_FOUND' }, { status: 404 });
    }

    // Audit the proposal (PROPOSED) — explainability, no ledger/schedule write.
    let decisionId: string | null = null;
    try {
      const { data: dec } = await ctx.supabase
        .from('ai_decisions')
        .insert({
          org_id: ctx.orgId,
          location_id: proposal.location_id,
          feature: PREPAID_PROPOSE_FEATURE,
          input_summary: `Prepaid proposal from bill line — ${proposal.description ?? proposal.vendor_name ?? 'expense'}`.slice(0, 2000),
          proposed_output: { kind: 'prepaid_from_bill', bill_id: body.bill_id, bill_line_id: body.bill_line_id, proposal },
          reasoning:
            'Proposed a straight-line prepaid amortization from an existing bill line. Confirmed only via the gated /api/prepaid create path — nothing posts here.',
          status: 'PROPOSED',
          created_by_user: ctx.userId,
        })
        .select('id')
        .single();
      decisionId = (dec as { id: string } | null)?.id ?? null;
    } catch (e) {
      console.error('[prepaid/propose] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
    }

    return NextResponse.json({ proposal, decisionId });
  },
);
