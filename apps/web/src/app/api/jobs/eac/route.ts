export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { formatMoney } from '@meritbooks/shared';
import { apiQueryHandler, type ApiContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { computeEac, rollupEac, type EacInput, type EacResult, type EacMethod } from '@/lib/jobcost/eac';

/**
 * GET /api/jobs/eac — Estimate-at-Completion / cost-to-complete forecast.
 *
 * Read-only, RLS-scoped (tenant isolation is enforced by the DB, not by this
 * route remembering to filter). Two shapes:
 *   • ?job_id=<uuid>            → one job's EAC (+ optional AI narrative & flag)
 *   • (no job_id)               → portfolio: every open job + a roll-up
 *
 * Every cent is computed by lib/jobcost/eac.ts (deterministic). The Core AI
 * gateway is invoked ONLY when ?explain=1 on a single job, and ONLY to phrase the
 * already-computed figures — it never authors a number (canon §3). When a job is
 * projecting a loss or fading, that explained result is logged to the
 * ai_decisions → /exceptions rail as a PROPOSED row (feature JOB_EAC).
 */

const JOB_EAC_FEATURE = 'JOB_EAC';
const JOB_EAC_MODEL = 'claude-sonnet-4-20250514';

const OPEN_STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETE'];

const querySchema = z.object({
  job_id: z.string().uuid().optional(),
  method: z.enum(['COST_TO_COST', 'COMMITMENTS', 'PROGRESS']).optional(),
  location_ids: z.string().max(2000).optional(),
  explain: z.string().optional(),
  fade_bps: z.coerce.number().int().min(0).max(10000).optional(),
});
type Query = z.infer<typeof querySchema>;

const JOB_SELECT = `
  id, job_number, name, status,
  contract_amount_cents, estimated_revenue_cents, estimated_cost_cents,
  budget_labor_cents, budget_materials_cents, budget_subcontractor_cents, budget_other_cents,
  actual_cost_cents, pct_complete,
  location:locations!jobs_location_id_fkey(short_code)
`;

interface JobRow {
  id: string;
  job_number: string;
  name: string;
  status: string;
  contract_amount_cents: number | null;
  estimated_revenue_cents: number | null;
  estimated_cost_cents: number | null;
  budget_labor_cents: number | null;
  budget_materials_cents: number | null;
  budget_subcontractor_cents: number | null;
  budget_other_cents: number | null;
  actual_cost_cents: number | null;
  pct_complete: number | null;
  location: { short_code: string | null } | { short_code: string | null }[] | null;
}

function num(x: number | null | undefined): number {
  return Number(x ?? 0);
}

function shortCode(loc: JobRow['location']): string {
  const l = Array.isArray(loc) ? loc[0] : loc;
  return l?.short_code ?? '--';
}

/** Build the deterministic EAC input for a job row + its open-commitment total. */
function toEacInput(j: JobRow, committedOpenCents: number): EacInput {
  const budgetSum =
    num(j.budget_labor_cents) +
    num(j.budget_materials_cents) +
    num(j.budget_subcontractor_cents) +
    num(j.budget_other_cents);
  const contract = num(j.contract_amount_cents) || num(j.estimated_revenue_cents);
  const budget = num(j.estimated_cost_cents) || budgetSum;
  // The original detailed category budget is the baseline for variance-vs-budget;
  // fall back to the estimate when categories are empty.
  const originalBudget = budgetSum || num(j.estimated_cost_cents);
  const pct = num(j.pct_complete);
  return {
    contractValueCents: contract,
    originalBudgetCents: originalBudget,
    budgetCents: budget,
    costsToDateCents: num(j.actual_cost_cents),
    committedOpenCents: committedOpenCents,
    progressPctComplete: pct > 0 ? pct / 100 : null,
  };
}

/** Sum PENDING (committed, not yet cleared) job-cost attributions per job. */
async function fetchCommittedOpen(
  supabase: SupabaseClient,
  orgId: string,
  jobIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (jobIds.length === 0) return map;
  const { data } = await supabase
    .from('job_cost_attributions')
    .select('job_id, amount_cents, lifecycle')
    .eq('org_id', orgId)
    .eq('lifecycle', 'PENDING')
    .in('job_id', jobIds);
  for (const a of (data ?? []) as { job_id: string; amount_cents: number }[]) {
    map.set(a.job_id, (map.get(a.job_id) ?? 0) + Number(a.amount_cents));
  }
  return map;
}

function jobMeta(j: JobRow) {
  return { id: j.id, jobNumber: j.job_number, jobName: j.name, status: j.status, company: shortCode(j.location) };
}

// ── AI narrative (phrasing only; never authors a number) ──────────────────────

const SYSTEM_EAC =
  'You are a construction controller writing a one-paragraph cost-to-complete note for a project. ' +
  'You are given an estimate-at-completion that has ALREADY been computed from the job ledger. ' +
  'STRICT RULES: (1) Use ONLY the dollar figures and percentages provided — never invent, recompute, ' +
  'round differently, or introduce any number not in the facts. (2) State the projected final cost (EAC), ' +
  'the remaining cost to complete, and the projected final margin, and whether the job is projecting a loss ' +
  'or fading vs the original budget. (3) Do not speculate about causes the data does not contain. ' +
  '(4) 2-4 tight sentences, plain prose, no markdown, no headings.';

function eacFacts(meta: ReturnType<typeof jobMeta>, r: EacResult): string {
  const marginPct = r.estimatedFinalMarginPct == null ? 'n/a' : `${r.estimatedFinalMarginPct}%`;
  const origPct = r.originalMarginPct == null ? 'n/a' : `${r.originalMarginPct}%`;
  return [
    `Job ${meta.jobNumber} — ${meta.jobName} (${meta.company}).`,
    `Method: ${r.method}. %-complete used: ${r.pctCompleteDisplay}%.`,
    `Contract value: ${formatMoney(r.contractValueCents)}.`,
    `Original budget: ${formatMoney(r.originalBudgetCents)} (margin ${origPct}).`,
    `Costs to date: ${formatMoney(r.costsToDateCents)}; open commitments: ${formatMoney(r.committedOpenCents)}.`,
    `Estimate at completion (EAC): ${formatMoney(r.eacCents)}; cost to complete: ${formatMoney(r.costToCompleteCents)}.`,
    `Projected final margin: ${formatMoney(r.estimatedFinalMarginCents)} (${marginPct}).`,
    `Variance vs original budget: ${formatMoney(r.varianceVsBudgetCents)} (positive = overrun).`,
    `Projected loss: ${r.projectedLoss ? 'YES' : 'no'}. Margin fade: ${r.marginFade ? `YES (${r.marginFadeBps} bps)` : 'no'}.`,
  ].join('\n');
}

function deterministicNote(meta: ReturnType<typeof jobMeta>, r: EacResult): string {
  const flag = r.projectedLoss
    ? 'is projecting a LOSS'
    : r.marginFade
      ? 'is fading vs its original margin'
      : 'is tracking to plan';
  const marginPct = r.estimatedFinalMarginPct == null ? '' : ` (${r.estimatedFinalMarginPct}%)`;
  return `${meta.jobNumber} ${flag}: EAC ${formatMoney(r.eacCents)} against a ${formatMoney(r.contractValueCents)} contract, leaving a projected margin of ${formatMoney(r.estimatedFinalMarginCents)}${marginPct}. Cost to complete is ${formatMoney(r.costToCompleteCents)}.`;
}

async function explainAndFlag(
  ctx: ApiContext,
  meta: ReturnType<typeof jobMeta>,
  r: EacResult,
): Promise<{ narrative: string; source: 'ai' | 'deterministic'; decisionId: string | null; model: string | null }> {
  const atRisk = r.projectedLoss || r.marginFade;
  const apiKey = getAnthropicApiKey();

  let narrative = deterministicNote(meta, r);
  let source: 'ai' | 'deterministic' = 'deterministic';
  let model: string | null = null;
  let correlationId: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let costCents = 0;

  if (apiKey) {
    try {
      const gw = await runAiGateway(
        { supabase: createAdminSupabase(), anthropicApiKey: apiKey },
        {
          tenant_id: ctx.orgId ?? '',
          user_id: ctx.userId,
          module: 'BOOKS',
          feature: JOB_EAC_FEATURE,
          model: JOB_EAC_MODEL,
          system: SYSTEM_EAC,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: `FACTS (already computed — phrase these, do not alter):\n\n${eacFacts(meta, r)}\n\nWrite the note now.` },
              ],
            },
          ],
          max_tokens: 400,
        },
      );
      if (gw.status !== 'blocked' && gw.result != null) {
        const block = Array.isArray(gw.result)
          ? (gw.result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text')
          : null;
        const text = (block?.text ?? '').trim();
        if (text) {
          narrative = text;
          source = 'ai';
        }
        model = gw.model_used;
        correlationId = gw.correlation_id;
        tokensIn = gw.tokens.input;
        tokensOut = gw.tokens.output;
        costCents = gw.cost_cents;
      }
    } catch (e) {
      console.error('[jobs/eac] gateway error (non-fatal):', e);
    }
  }

  // Log a PROPOSED exception only for at-risk jobs, so it surfaces in /exceptions.
  let decisionId: string | null = null;
  if (atRisk) {
    try {
      const { data } = await ctx.supabase
        .from('ai_decisions')
        .insert({
          org_id: ctx.orgId,
          feature: JOB_EAC_FEATURE,
          model_requested: source === 'ai' ? JOB_EAC_MODEL : null,
          model_used: model,
          correlation_id: correlationId,
          input_summary: `EAC forecast — ${meta.jobNumber} ${meta.jobName}: ${r.projectedLoss ? 'projected loss' : 'margin fade'} (EAC ${formatMoney(r.eacCents)} vs contract ${formatMoney(r.contractValueCents)})`.slice(0, 2000),
          proposed_output: { kind: 'JOB_EAC_FORECAST', job: meta, eac: r, narrative },
          reasoning: 'Deterministic estimate-at-completion; AI phrasing only, figures authored in code (lib/jobcost/eac.ts).',
          status: 'PROPOSED',
          tokens_input: tokensIn || null,
          tokens_output: tokensOut || null,
          cost_cents: costCents || null,
          created_by_user: ctx.userId,
        })
        .select('id')
        .single();
      decisionId = (data as { id: string } | null)?.id ?? null;
    } catch (e) {
      console.error('[jobs/eac] decision log failed (non-fatal):', e);
    }
  }

  return { narrative, source, decisionId, model };
}

export const GET = apiQueryHandler(querySchema, async (q: Query, ctx: ApiContext) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const method: EacMethod = q.method ?? 'COMMITMENTS';
  const opts = q.fade_bps != null ? { method, fadeThresholdBps: q.fade_bps } : { method };

  // ── Single job ──────────────────────────────────────────────────────────────
  if (q.job_id) {
    const { data: job, error } = await ctx.supabase
      .schema('core')
      .from('jobs')
      .select(JOB_SELECT)
      .eq('id', q.job_id)
      .single();
    if (error || !job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

    const j = job as unknown as JobRow;
    const committed = await fetchCommittedOpen(ctx.supabase, ctx.orgId, [j.id]);
    const result = computeEac(toEacInput(j, committed.get(j.id) ?? 0), opts);
    const meta = jobMeta(j);

    if (q.explain === '1' || q.explain === 'true') {
      const explained = await explainAndFlag(ctx, meta, result);
      return NextResponse.json({ job: meta, method, eac: result, ...explained });
    }
    return NextResponse.json({ job: meta, method, eac: result });
  }

  // ── Portfolio ─────────────────────────────────────────────────────────────────
  let query = ctx.supabase
    .schema('core')
    .from('jobs')
    .select(JOB_SELECT)
    .in('status', OPEN_STATUSES)
    .order('job_number');
  if (q.location_ids) {
    const ids = q.location_ids.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) query = query.in('location_id', ids);
  }
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as JobRow[];
  const committed = await fetchCommittedOpen(ctx.supabase, ctx.orgId, rows.map((r) => r.id));

  const jobs = rows.map((j) => {
    const eac = computeEac(toEacInput(j, committed.get(j.id) ?? 0), opts);
    return { job: jobMeta(j), eac };
  });
  const totals = rollupEac(jobs.map((x) => x.eac));

  return NextResponse.json({ method, jobs, totals });
});
