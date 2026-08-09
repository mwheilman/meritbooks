export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { runAiGateway } from '@meritbooks/core-ai';
import { apiQueryHandler, type ApiContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  computeBriefingFacts,
  buildNarrativePrompt,
  deterministicNarrative,
  NARRATIVE_SYSTEM,
  type BriefingFacts,
  type JobMarginRow,
  type CostCodeSlipRow,
  type GateRow,
  type DrawRow,
} from '@/lib/portfolio/briefing';

/**
 * GET /api/portfolio/briefing — the dashboard "Portfolio briefing" auto-narrative.
 *
 * Mirrors the Books flux-narrative pattern (apps/web · api/reports/narrative):
 *   1. Load the portfolio rows RLS-scoped (ctx.supabase) — the SAME views the
 *      dashboard reads — and compute EVERY figure IN CODE (computeBriefingFacts).
 *   2. Hand ONLY those computed facts to the Core AI gateway (module=PROJECTS,
 *      feature=PORTFOLIO_NARRATIVE), which is told, strongly, to PHRASE not author.
 *   3. If the provider key is absent, or the gateway blocks / errors / returns
 *      nothing, fall back to a deterministic template so the panel always renders
 *      something truthful. The model never authors a figure.
 *
 * Read-only. The gateway's own metering is the audit rail (core.ai_usage_log);
 * no extra audit sink is written here.
 */

const PORTFOLIO_NARRATIVE_MODEL = 'claude-sonnet-4-20250514';
const PORTFOLIO_NARRATIVE_FEATURE = 'PORTFOLIO_NARRATIVE';

type BriefingSource = 'ai' | 'deterministic';

interface BriefingResponse {
  narrative: string;
  facts: BriefingFacts;
  source: BriefingSource;
}

/** Extract the first text block from an Anthropic content array. */
function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const block = (result as Array<{ type?: string; text?: string }>).find((b) => b?.type === 'text');
  return block?.text ?? null;
}

export const GET = apiQueryHandler(null, async (_params, ctx: ApiContext): Promise<NextResponse> => {
  if (!ctx.orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 403 });
  }

  // 1. Load the portfolio rows (RLS-scoped) — the exact dashboard queries.
  const [mRes, sRes, gRes, dRes] = await Promise.all([
    ctx.supabase
      .schema('proj')
      .from('v_job_margin')
      .select(
        'job_id, job_number, name, revenue_contract_cents, operational_actual_cents, operational_pending_cents, committed_open_cents, projected_final_cents, operational_margin_pct',
      ),
    ctx.supabase.schema('proj').from('v_cost_code_slippage').select('job_id, variance_cents'),
    ctx.supabase.schema('proj').from('external_gates').select('job_id, name, gate_type, status, blocks_billing'),
    ctx.supabase.schema('proj').from('billing_requests').select('job_id, status'),
  ]);

  const loadErr = mRes.error || sRes.error || gRes.error || dRes.error;
  if (loadErr) {
    return NextResponse.json(
      { error: loadErr.message, code: 'PORTFOLIO_QUERY_ERROR' },
      { status: 500 },
    );
  }

  const facts = computeBriefingFacts({
    margins: (mRes.data ?? []) as JobMarginRow[],
    slips: (sRes.data ?? []) as CostCodeSlipRow[],
    gates: (gRes.data ?? []) as GateRow[],
    draws: (dRes.data ?? []) as DrawRow[],
  });

  const fallback = (): BriefingResponse => ({
    narrative: deterministicNarrative(facts),
    facts,
    source: 'deterministic',
  });

  // No jobs → no model call; the deterministic line is friendly and truthful.
  if (facts.counts.jobs === 0) {
    return NextResponse.json(fallback());
  }

  // 2. Ask the gateway to PHRASE the computed facts. Honest deterministic
  //    response when no provider key is configured.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(fallback());
  }

  const prompt = buildNarrativePrompt(facts);
  const admin = createAdminSupabase();

  try {
    const gw = await runAiGateway(
      { supabase: admin, anthropicApiKey: apiKey },
      {
        tenant_id: ctx.orgId,
        user_id: ctx.userId,
        module: 'PROJECTS',
        feature: PORTFOLIO_NARRATIVE_FEATURE,
        model: PORTFOLIO_NARRATIVE_MODEL,
        system: NARRATIVE_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        max_tokens: 220,
      },
    );

    if (gw.status === 'blocked' || gw.result == null) {
      return NextResponse.json(fallback());
    }

    const text = extractText(gw.result);
    const narrative = (text ?? '').trim();
    if (!narrative) {
      return NextResponse.json(fallback());
    }

    const body: BriefingResponse = { narrative, facts, source: 'ai' };
    return NextResponse.json(body);
  } catch {
    // Gateway unreachable / provider error — never break the panel.
    return NextResponse.json(fallback());
  }
});
