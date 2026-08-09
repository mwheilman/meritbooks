export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runAiGateway } from '@meritbooks/core-ai';
import { apiQueryHandler, type ApiContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import {
  assembleBoardPackage,
  computeKpis,
  buildExecutiveSummaryFacts,
  deterministicExecutiveSummary,
  EXEC_SUMMARY_FEATURE,
  EXEC_SUMMARY_SYSTEM,
  type IncomeStatementPayload,
} from '@/lib/reports/board-package';
import {
  fetchIncomeStatement,
  fetchBalanceSheet,
  fetchCashFlow,
  fetchArAging,
  fetchApAging,
  fetchDebt,
  fetchTrendSeries,
} from './queries';
import type { TrendPoint } from '@/lib/reports/board-package';

/** How many trailing months the KPI trend strip spans. */
const TREND_PERIODS = 6;

/**
 * GET /api/reports/board-package — assemble a board-ready financial package.
 *
 * READ-ONLY, RLS-scoped (via ctx.supabase). Every figure is computed/pulled
 * deterministically from the ledger; the ONLY AI surface is the executive
 * summary, generated (feature BOARD_NARRATIVE) when `ai=1` — and even then the
 * gateway only PHRASES the pre-computed KPI facts (see board-package.ts). Without
 * `ai=1` a truthful deterministic executive summary is returned, so the package
 * always renders.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const schema = z.object({
  start_date: DATE.optional(),
  end_date: DATE.optional(),
  as_of_date: DATE.optional(),
  location_ids: z.string().max(2000).optional(),
  basis: z.enum(['accrual', 'cash']).optional(),
  entity_label: z.string().max(200).optional(),
  /** '1' → generate the AI executive summary; anything else → deterministic. */
  ai: z.string().optional(),
});
type Params = z.infer<typeof schema>;

const EXEC_MODEL = 'claude-sonnet-4-20250514';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** Equal-length window ending immediately before [sd, ed]; whole-month aware. */
function derivePriorPeriod(sd: string, ed: string): { s: string; e: string } {
  const [ay, am, ad] = sd.split('-').map(Number);
  const [by, bm, bd] = ed.split('-').map(Number);
  const wholeMonths = ad === 1 && bd === lastDayOfMonth(by, bm);
  if (wholeMonths) {
    const span = (by * 12 + bm) - (ay * 12 + am) + 1;
    const psIdx = ay * 12 + (am - 1) - span;
    const peIdx = ay * 12 + (am - 1) - 1;
    const psY = Math.floor(psIdx / 12);
    const psM = (psIdx % 12) + 1;
    const peY = Math.floor(peIdx / 12);
    const peM = (peIdx % 12) + 1;
    return { s: `${psY}-${pad(psM)}-01`, e: `${peY}-${pad(peM)}-${pad(lastDayOfMonth(peY, peM))}` };
  }
  const lenDays = Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000) + 1;
  const peD = new Date(Date.UTC(ay, am - 1, ad) - 86400000);
  const psD = new Date(peD.getTime() - (lenDays - 1) * 86400000);
  const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { s: iso(psD), e: iso(peD) };
}

export const GET = apiQueryHandler(schema, async (params: Params, ctx: ApiContext) => {
  const now = new Date();
  const startDate = params.start_date ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const endDate = params.end_date ?? new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
  const asOfDate = params.as_of_date ?? endDate;
  const basis = params.basis ?? 'accrual';
  const locationIds = params.location_ids ? params.location_ids.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const entityLabel =
    params.entity_label && params.entity_label.trim() ? params.entity_label.trim() : 'All Companies (Consolidated)';
  const prior = derivePriorPeriod(startDate, endDate);

  // 1. Pull all statement payloads deterministically (RLS-scoped, org-isolated).
  let currentIS: IncomeStatementPayload;
  let priorIS: IncomeStatementPayload | null = null;
  let balanceSheet, cashFlow, arAging, apAging, debt;
  let trendSeries: TrendPoint[] = [];
  try {
    [currentIS, priorIS, balanceSheet, cashFlow, arAging, apAging, debt, trendSeries] = await Promise.all([
      fetchIncomeStatement(ctx.supabase, { startDate, endDate, locationIds, basis }),
      fetchIncomeStatement(ctx.supabase, { startDate: prior.s, endDate: prior.e, locationIds, basis }),
      fetchBalanceSheet(ctx.supabase, { asOfDate, locationIds }),
      fetchCashFlow(ctx.supabase, ctx.orgId ?? '', { startDate, endDate, locationIds }),
      fetchArAging(ctx.supabase, locationIds),
      fetchApAging(ctx.supabase, locationIds),
      fetchDebt(ctx.supabase, locationIds),
      fetchTrendSeries(ctx.supabase, ctx.orgId ?? '', { endDate, locationIds, basis, periods: TREND_PERIODS }),
    ]);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to load report data', code: 'REPORT_QUERY_ERROR' },
      { status: 500 },
    );
  }

  const periodLabel = `${startDate} to ${endDate}`;
  const priorPeriodLabel = `${prior.s} to ${prior.e}`;
  const basisLabel = basis === 'cash' ? 'Cash basis' : 'Accrual basis';
  const generatedAt = new Date().toISOString();
  // Inclusive day count of the reporting window — drives DSO/DPO.
  const periodDays =
    Math.round(
      (Date.UTC(...(endDate.split('-').map(Number) as [number, number, number])) -
        Date.UTC(...(startDate.split('-').map(Number) as [number, number, number]))) /
        86_400_000,
    ) + 1;
  const meta = {
    entityLabel,
    periodLabel,
    periodStart: startDate,
    periodEnd: endDate,
    asOfDate,
    generatedAt,
    basisLabel,
    accent: '#10b981',
  };

  // 2. Executive summary. Deterministic by default; AI phrasing only on ai=1.
  const kpis = computeKpis({ currentIS, priorIS, balanceSheet, cashFlow, arAging, apAging, debt, periodDays });
  let executiveSummary: { text: string; source: 'ai' | 'deterministic'; model: string | null } = {
    text: deterministicExecutiveSummary(kpis, entityLabel, periodLabel),
    source: 'deterministic',
    model: null,
  };
  let aiMessage: string | null = null;

  if (params.ai === '1') {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
      aiMessage = 'AI provider key not configured';
    } else {
      const facts = buildExecutiveSummaryFacts(kpis, entityLabel, periodLabel);
      const prompt = `FACTS (already computed — phrase these, do not alter or add any number):\n\n${facts}\n\nWrite the executive summary now.`;
      try {
        const gw = await runAiGateway(
          { supabase: createAdminSupabase(), anthropicApiKey: apiKey },
          {
            tenant_id: ctx.orgId ?? '',
            user_id: ctx.userId,
            module: 'BOOKS',
            feature: EXEC_SUMMARY_FEATURE,
            model: EXEC_MODEL,
            system: EXEC_SUMMARY_SYSTEM,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            max_tokens: 500,
          },
        );
        if (gw.status === 'blocked' || gw.result == null) {
          aiMessage = gw.message ?? 'AI request blocked';
        } else {
          const block = Array.isArray(gw.result)
            ? (gw.result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text')
            : null;
          const text = (block?.text ?? '').trim();
          if (text) {
            executiveSummary = { text, source: 'ai', model: gw.model_used };
            // Audit the AI proposal to the decision-log rail (org-scoped, RLS).
            try {
              await ctx.supabase.from('ai_decisions').insert({
                org_id: ctx.orgId,
                feature: EXEC_SUMMARY_FEATURE,
                model_requested: EXEC_MODEL,
                model_used: gw.model_used,
                correlation_id: gw.correlation_id,
                input_summary: `Board package executive summary — ${entityLabel}: ${periodLabel}`.slice(0, 2000),
                proposed_output: { executiveSummary: text },
                reasoning: 'AI phrasing of deterministically-computed KPI figures; figures authored in code, not by the model.',
                status: 'PROPOSED',
                tokens_input: gw.tokens.input,
                tokens_output: gw.tokens.output,
                cost_cents: gw.cost_cents,
                created_by_user: ctx.userId,
              });
            } catch (e) {
              console.error('[board-package] decision log failed (non-fatal):', e);
            }
          } else {
            aiMessage = 'AI returned no text; using deterministic summary';
          }
        }
      } catch (e) {
        aiMessage = e instanceof Error ? e.message : 'Gateway error';
      }
    }
  }

  const pkg = assembleBoardPackage({
    meta,
    currentIS,
    priorIS,
    balanceSheet,
    cashFlow,
    arAging,
    apAging,
    debt,
    executiveSummary,
    periodDays,
    priorPeriodLabel,
    trendSeries,
  });

  return NextResponse.json({ ...pkg, aiMeta: { requested: params.ai === '1', message: aiMessage } });
});
