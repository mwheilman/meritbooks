export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { viewQueryRouteSchema } from '@/lib/fpna/workspace/query';
import { prepare } from '@/lib/fpna/workspace/server/load';
import { buildView } from '@/lib/fpna/workspace/server/views';
import { buildViewFactSheet, deterministicSummary } from '@/lib/fpna/workspace/facts';
import { draftViewSummary, FPNA_SUMMARY_FEATURE, FPNA_SUMMARY_MODEL } from '@/lib/fpna/workspace/commentary';
import { noOrg, serverCtx, workspaceErrorResponse } from '@/lib/fpna/workspace/server/route-support';
import { TAB_LABEL } from '@/lib/fpna/workspace/types';
import { userRateLimited } from '@/lib/security/user-limits';
import { createHash } from 'node:crypto';

/**
 * POST /api/fpna/workspace/summarize — "Summarize this view" (AC-W10), a DRAFT.
 *
 * The server RECOMPUTES the view from the same parameters (the client sends no figures),
 * builds the fact sheet from it and asks the Core AI gateway (FPNA_SUMMARY) to phrase 3–6
 * cited bullets. A draft that cites an unknown fact, cites nothing, or quotes a $ / % not in
 * the facts is refused; AI down → `{ unavailable: true }`. Every response carries the
 * deterministic sentences. The one write is an ai_decisions PROPOSED row.
 * reports:view; governed exactly like the view (a non-finance reader's facts hold released
 * months only). Per-user rate limit (an AI call per press).
 *
 * Security review M2: the decision row is the audit of the AI call, not a copy of the answer — it
 * holds METADATA only (tab, period, company ids, bullet count, a SHA-256 of the bullets) and never
 * the bullets' figures, and it is tagged with the company when the view covers exactly one (so
 * 163's client scope applies). The bullets go back to the reader only.
 */
export const POST = apiHandler(viewQueryRouteSchema, async (q, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'reports', 'view', { route: '/api/fpna/workspace/summarize' });
  if (!guard.ok) return guard.response;
  const limited = userRateLimited('fpnaSummarize', ctx.userId);
  if (limited) return limited;
  try {
    const p = await prepare(serverCtx({ ...ctx, orgId: ctx.orgId }));
    const view = await buildView(p, q, { role: guard.role });
    const names = view.scope.companies.map((c) => c.name);
    const scopeLabel = names.length === 1 ? names[0] : `${names.length} companies${q.weighting === 'ownership' ? ', ownership-weighted' : ''}`;
    const sheet = buildViewFactSheet(view, scopeLabel);
    const deterministic = deterministicSummary(view);
    const result = await draftViewSummary({ supabase: serviceWriter(), anthropicApiKey: getAnthropicApiKey() }, { orgId: ctx.orgId, userId: ctx.userId, sheet });
    if (result.kind === 'unavailable') return NextResponse.json({ unavailable: true, code: 'AI_UNAVAILABLE', message: result.message, deterministic });
    if (result.kind === 'refused') return NextResponse.json({ refused: true, problems: result.problems, deterministic });

    let decisionId: string | null = null;
    try {
      const { data } = await serviceWriter()
        .from('ai_decisions')
        .insert({
          org_id: ctx.orgId,
          location_id: view.scope.companies.length === 1 ? view.scope.companies[0].id : null,
          feature: FPNA_SUMMARY_FEATURE,
          model_requested: FPNA_SUMMARY_MODEL,
          model_used: result.model,
          correlation_id: result.correlationId,
          input_summary: `FP&A summary draft — ${TAB_LABEL[view.tab]}, ${view.scope.companies.length} compan${view.scope.companies.length === 1 ? 'y' : 'ies'}, ${view.period.label}`.slice(0, 2000),
          // Metadata only (M2): never the bullets / figures.
          proposed_output: {
            tab: view.tab,
            period: { label: view.period.label },
            companies: view.scope.companies.map((c) => c.id),
            epoch: view.epoch,
            bullet_count: result.bullets.length,
            output_sha256: createHash('sha256').update(JSON.stringify(result.bullets)).digest('hex'),
          },
          reasoning: 'AI phrasing of the computed FP&A view; every figure and citation verified against the fact sheet before display.',
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
      console.error('[fpna/workspace/summarize] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
    }
    return NextResponse.json({ draft: { bullets: result.bullets, model: result.model, decisionId }, facts: sheet.lines, deterministic });
  } catch (e) {
    return workspaceErrorResponse(e, 'fpna/workspace/summarize');
  }
});
