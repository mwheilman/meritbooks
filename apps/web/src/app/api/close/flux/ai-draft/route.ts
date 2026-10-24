export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { loadFluxBoard } from '@/lib/close/flux/load';
import { buildFactSheet, draftFluxExplanation, driverSummary, FLUX_EXPLAIN_FEATURE, FLUX_EXPLAIN_MODEL, promptSafe } from '@/lib/close/flux/ai-draft';
import { fluxErrorResponse, noOrg } from '@/lib/close/flux/route-support';

/**
 * POST /api/close/flux/ai-draft — draft an explanation for one flux line from its
 * deterministic drivers, through the Core AI gateway (feature FLUX_EXPLAIN).
 *
 * Writes NOTHING to flux_explanations: the draft is returned to the editor and only becomes
 * an explanation when a person edits/accepts and submits it. The one write is an org-level
 * `ai_decisions` PROPOSED row (no location_id, so it never blocks the review-queue task);
 * it is marked APPROVED when the draft is accepted.
 *
 * Every response carries the deterministic driver summary. When AI is down the response is
 * `{ unavailable: true }` with that summary, so the person can write from it; a draft whose
 * figures or citations don't trace to the ledger facts is refused the same way.
 */
const schema = z.object({
  location_id: z.string().uuid(),
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  line_key: z.string().min(1).max(200),
});

export const POST = apiHandler(schema, async (b, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'view', { locationId: b.location_id });
  if (!guard.ok) return guard.response;
  try {
    const board = await loadFluxBoard(ctx.supabase, ctx.orgId, { locationId: b.location_id, year: b.year, month: b.month });
    const line = board.lines.find((l) => l.lineKey === b.line_key);
    if (!line) return NextResponse.json({ error: 'That flux line has no activity this month.', code: 'LINE_NOT_FOUND' }, { status: 404 });

    const summary = driverSummary(line, line.drivers);
    const sheet = buildFactSheet(line, line.drivers, board.period.key);
    const result = await draftFluxExplanation(
      { supabase: serviceWriter(), anthropicApiKey: getAnthropicApiKey() },
      { orgId: ctx.orgId, userId: ctx.userId, sheet },
    );

    if (result.kind === 'unavailable') {
      return NextResponse.json({ unavailable: true, code: 'AI_UNAVAILABLE', message: result.message, summary });
    }
    if (result.kind === 'refused') {
      return NextResponse.json({ refused: true, problems: result.problems, summary });
    }

    let decisionId: string | null = null;
    try {
      const { data } = await serviceWriter()
        .from('ai_decisions')
        .insert({
          org_id: ctx.orgId,
          feature: FLUX_EXPLAIN_FEATURE,
          model_requested: FLUX_EXPLAIN_MODEL,
          model_used: result.model,
          correlation_id: result.correlationId,
          input_summary: `Flux explanation draft — ${promptSafe(line.accountNumber, 40)} ${promptSafe(line.accountName, 120)}, ${promptSafe(board.location.name, 120)}, ${board.period.label}`.slice(0, 2000),
          proposed_output: { explanation: result.explanation, category: result.category, citations: result.citations, line_key: line.lineKey, location_id: b.location_id, period_key: board.period.key },
          reasoning: 'AI phrasing of deterministically ranked drivers; every figure verified against the ledger facts before display.',
          status: 'PROPOSED',
          tokens_input: result.tokens.input,
          tokens_output: result.tokens.output,
          cost_cents: result.costCents,
          created_by_user: ctx.userId,
        })
        .select('id')
        .single();
      decisionId = (data as { id: string } | null)?.id ?? null;
    } catch (e) {
      console.error('[close/flux/ai-draft] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
    }

    return NextResponse.json({
      draft: { explanation: result.explanation, category: result.category, citations: result.citations, decisionId, model: result.model },
      summary,
    });
  } catch (e) {
    return fluxErrorResponse(e, 'close/flux/ai-draft');
  }
});
