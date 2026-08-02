export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { formatMoney } from '@meritbooks/shared';
import { apiHandler, type ApiContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  computeVariances,
  type VarianceLine,
  type VarianceDriver,
  type VarianceResult,
} from '@/lib/reports/variance';

/**
 * POST /api/reports/narrative — AI flux / variance auto-narrative (M7).
 *
 * The "why did this move" layer for financial reports. Read-only. The pipeline:
 *   1. DETERMINISTICALLY aggregate each period's report line items from the GL
 *      (RLS-scoped, org-isolated) and compute the ranked variances IN CODE
 *      (lib/reports/variance.ts) — the model never sees the ledger.
 *   2. Hand ONLY those computed driver facts to the Core AI gateway, which is
 *      told, in the strongest terms, to phrase (not recompute) them.
 *   3. Return { narrative, drivers, citations } — where `drivers` and every
 *      figure come from OUR computation; the model authors only the prose.
 *
 * If the gateway is unavailable or budget-blocked, a deterministic template
 * narrative is returned so the panel always renders something truthful.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const periodSchema = z.object({
  start_date: DATE.optional(),
  end_date: DATE.optional(),
  as_of_date: DATE.optional(),
  label: z.string().max(120).optional(),
});

const schema = z.object({
  report: z.enum(['pnl', 'balance_sheet']),
  periodA: periodSchema, // current period
  periodB: periodSchema, // comparison period (prior period / prior year / budget window)
  dimensions: z
    .object({
      location_ids: z.string().max(2000).optional(),
      department_id: z.string().uuid().optional(),
      class_id: z.string().uuid().optional(),
      basis: z.enum(['accrual', 'cash']).optional(),
    })
    .optional(),
});

type Body = z.infer<typeof schema>;
type Dimensions = NonNullable<Body['dimensions']>;

export const NARRATIVE_MODEL = 'claude-sonnet-4-20250514';
export const NARRATIVE_FEATURE = 'FLUX_NARRATIVE';

// ── Nested join shape (mirrors income-statement / balance-sheet routes) ──────
interface JoinedLine {
  account_id: string;
  debit_cents: number | null;
  credit_cents: number | null;
  accounts: {
    account_number: string;
    name: string;
    account_type: string;
    account_groups: {
      account_sub_types: {
        account_types: { normal_balance: string };
      };
    };
  };
}

function resolveLocationIds(dims?: Dimensions): string[] {
  if (!dims?.location_ids) return [];
  return dims.location_ids.split(',').map((s) => s.trim()).filter(Boolean);
}

const SELECT = `
  account_id,
  debit_cents,
  credit_cents,
  accounts!inner(
    account_number,
    name,
    account_type,
    account_groups!inner(
      account_sub_types!inner(
        account_types!inner(
          normal_balance
        )
      )
    )
  ),
  gl_entries!inner(
    entry_date,
    status
  )
`;

/** Aggregate signed per-account amounts into VarianceLine[], the same way the
 *  on-screen statement does (amount derived from the account's normal balance). */
function aggregate(rows: JoinedLine[]): VarianceLine[] {
  const map = new Map<string, { label: string; section: string; normal: string; debits: number; credits: number }>();
  for (const line of rows) {
    const acct = line.accounts;
    const normal = acct.account_groups.account_sub_types.account_types.normal_balance;
    const key = acct.account_number;
    const existing = map.get(key);
    if (existing) {
      existing.debits += Number(line.debit_cents ?? 0);
      existing.credits += Number(line.credit_cents ?? 0);
    } else {
      map.set(key, {
        label: acct.name,
        section: acct.account_type,
        normal,
        debits: Number(line.debit_cents ?? 0),
        credits: Number(line.credit_cents ?? 0),
      });
    }
  }
  const lines: VarianceLine[] = [];
  for (const [key, v] of map) {
    const amountCents = v.normal === 'CREDIT' ? v.credits - v.debits : v.debits - v.credits;
    lines.push({ key, label: v.label, section: v.section, amountCents });
  }
  return lines;
}

/** P&L line items for a date range (REVENUE/COGS/OPEX/OTHER). */
async function fetchPnlLines(
  supabase: SupabaseClient,
  startDate: string,
  endDate: string,
  dims?: Dimensions,
): Promise<VarianceLine[]> {
  const locationIds = resolveLocationIds(dims);
  let query = supabase
    .from('gl_entry_lines')
    .select(SELECT)
    .eq('gl_entries.status', 'POSTED')
    .gte('gl_entries.entry_date', startDate)
    .lte('gl_entries.entry_date', endDate)
    .in('accounts.account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER']);

  if (locationIds.length === 1) query = query.eq('location_id', locationIds[0]);
  else if (locationIds.length > 1) query = query.in('location_id', locationIds);
  if (dims?.department_id) query = query.eq('department_id', dims.department_id);
  if (dims?.class_id) query = query.eq('class_id', dims.class_id);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return aggregate((data ?? []) as unknown as JoinedLine[]);
}

/** Balance-sheet line items as of a date (ASSET/LIABILITY/EQUITY). */
async function fetchBsLines(
  supabase: SupabaseClient,
  asOfDate: string,
  dims?: Dimensions,
): Promise<VarianceLine[]> {
  const locationIds = resolveLocationIds(dims);
  let query = supabase
    .from('gl_entry_lines')
    .select(SELECT)
    .eq('gl_entries.status', 'POSTED')
    .lte('gl_entries.entry_date', asOfDate)
    .in('accounts.account_type', ['ASSET', 'LIABILITY', 'EQUITY']);

  if (locationIds.length === 1) query = query.eq('location_id', locationIds[0]);
  else if (locationIds.length > 1) query = query.in('location_id', locationIds);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return aggregate((data ?? []) as unknown as JoinedLine[]);
}

// ── Prompt + parsing ─────────────────────────────────────────────────────────

function money(cents: number): string {
  return formatMoney(cents);
}

function driverFactLine(d: VarianceDriver, i: number): string {
  const pct = d.pct == null ? 'new vs prior' : `${d.pct > 0 ? '+' : ''}${d.pct}%`;
  const fav = d.favorable == null ? '' : d.favorable ? ' [favorable]' : ' [unfavorable]';
  const arrow = d.direction === 'up' ? 'up' : d.direction === 'down' ? 'down' : 'flat';
  return `${i + 1}. ${d.section} · ${d.line}: ${money(d.priorCents)} -> ${money(d.currentCents)} (${arrow} ${d.deltaCents > 0 ? '+' : ''}${money(d.deltaCents)}, ${pct})${fav}`;
}

function buildFacts(
  reportLabel: string,
  labelA: string,
  labelB: string,
  v: VarianceResult,
): string {
  const netLine =
    v.netCurrentCents != null && v.netPriorCents != null
      ? `Net income: prior ${money(v.netPriorCents)} -> current ${money(v.netCurrentCents)} (change ${v.netDeltaCents! > 0 ? '+' : ''}${money(v.netDeltaCents!)}).`
      : '';
  const driverLines = v.drivers.map((d, i) => driverFactLine(d, i)).join('\n');
  return [
    `Report: ${reportLabel}`,
    `Current period (A): ${labelA}`,
    `Prior/comparison period (B): ${labelB}`,
    netLine,
    '',
    'Largest computed line-item variances (already calculated — use these figures verbatim, do not alter or add any number):',
    driverLines || '(no material variances)',
  ]
    .filter(Boolean)
    .join('\n');
}

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/** Deterministic, no-speculation fallback narrative (used if AI is unavailable). */
function deterministicNarrative(v: VarianceResult): string {
  if (v.drivers.length === 0) return 'No material line-item variances between the two periods.';
  const parts: string[] = [];
  if (v.netCurrentCents != null && v.netDeltaCents != null && v.netDeltaCents !== 0) {
    parts.push(
      `Net income moved ${v.netDeltaCents > 0 ? 'up' : 'down'} ${money(Math.abs(v.netDeltaCents))} to ${money(v.netCurrentCents)}.`,
    );
  }
  const top = v.drivers.slice(0, 3).map((d) => {
    const pct = d.pct == null ? '' : ` (${d.pct > 0 ? '+' : ''}${d.pct}%)`;
    return `${d.line} ${d.direction === 'up' ? 'rose' : 'fell'} ${money(Math.abs(d.deltaCents))}${pct}`;
  });
  parts.push(`Largest movers: ${top.join('; ')}. The ledger does not explain the underlying cause of each move; drill into the accounts for detail.`);
  return parts.join(' ');
}

// ── Citations (deterministic drill anchors) ──────────────────────────────────

function buildCitations(body: Body, v: VarianceResult): { label: string; href: string }[] {
  const reportKey = body.report === 'pnl' ? 'pnl' : 'bs';
  const citations: { label: string; href: string }[] = [
    { label: `${body.report === 'pnl' ? 'Profit & Loss' : 'Balance Sheet'} — source statement`, href: `/reports?report=${reportKey}` },
  ];
  for (const d of v.drivers.slice(0, 3)) {
    citations.push({ label: `GL detail · ${d.line} (${d.key})`, href: `/reports?report=gl&account=${encodeURIComponent(d.key)}` });
  }
  return citations;
}

function periodLabel(report: Body['report'], p: Body['periodA']): string {
  if (p.label) return p.label;
  if (report === 'balance_sheet') return p.as_of_date ? `as of ${p.as_of_date}` : 'as of date';
  return p.start_date && p.end_date ? `${p.start_date} to ${p.end_date}` : 'selected period';
}

// ── Handler ──────────────────────────────────────────────────────────────────

export const POST = apiHandler(schema, async (body: Body, ctx: ApiContext) => {
  // 1. Deterministically fetch + compute variances (RLS-scoped, org-isolated).
  let currentLines: VarianceLine[];
  let priorLines: VarianceLine[];
  try {
    if (body.report === 'pnl') {
      if (!body.periodA.start_date || !body.periodA.end_date || !body.periodB.start_date || !body.periodB.end_date) {
        return NextResponse.json({ error: 'P&L narrative requires start_date and end_date for both periods.', code: 'MISSING_DATES' }, { status: 422 });
      }
      currentLines = await fetchPnlLines(ctx.supabase, body.periodA.start_date, body.periodA.end_date, body.dimensions);
      priorLines = await fetchPnlLines(ctx.supabase, body.periodB.start_date, body.periodB.end_date, body.dimensions);
    } else {
      if (!body.periodA.as_of_date || !body.periodB.as_of_date) {
        return NextResponse.json({ error: 'Balance-sheet narrative requires as_of_date for both periods.', code: 'MISSING_DATES' }, { status: 422 });
      }
      currentLines = await fetchBsLines(ctx.supabase, body.periodA.as_of_date, body.dimensions);
      priorLines = await fetchBsLines(ctx.supabase, body.periodB.as_of_date, body.dimensions);
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to load report data', code: 'REPORT_QUERY_ERROR' }, { status: 500 });
  }

  const variance = computeVariances(currentLines, priorLines, {
    mode: body.report === 'pnl' ? 'pnl' : 'neutral',
  });

  const reportLabel = body.report === 'pnl' ? 'Profit & Loss (flux vs prior)' : 'Balance Sheet (movement vs prior)';
  const labelA = periodLabel(body.report, body.periodA);
  const labelB = periodLabel(body.report, body.periodB);
  const citations = buildCitations(body, variance);

  // The response `drivers` ALWAYS come from our computation, never the model.
  const responseDrivers = variance.drivers.map((d) => ({
    line: d.line,
    key: d.key,
    section: d.section,
    currentCents: d.currentCents,
    priorCents: d.priorCents,
    deltaCents: d.deltaCents,
    pct: d.pct,
    direction: d.direction,
    favorable: d.favorable,
  }));

  // No movement → truthful, no model call.
  if (variance.drivers.length === 0) {
    return NextResponse.json({
      narrative: 'No material line-item variances between the two periods.',
      drivers: responseDrivers,
      citations,
      meta: { report: body.report, source: 'deterministic', model: null, decisionId: null, budgetState: 'under' },
    });
  }

  const facts = buildFacts(reportLabel, labelA, labelB, variance);

  // 2. Ask the gateway to PHRASE the computed facts. Fall back deterministically.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      narrative: deterministicNarrative(variance),
      drivers: responseDrivers,
      citations,
      meta: { report: body.report, source: 'deterministic', model: null, decisionId: null, budgetState: 'under', message: 'AI provider key not configured' },
    });
  }

  const system =
    'You are a controller writing the flux/variance section of a board financial package. ' +
    'You are given variances that have ALREADY been computed from the general ledger. ' +
    'STRICT RULES: (1) Use ONLY the dollar figures and percentages provided — never invent, recompute, round differently, or introduce any number that is not in the facts. ' +
    '(2) Do not speculate about business causes the data does not contain; if a driver has no explanation in the facts, describe the movement and note the cause is not determinable from the ledger. ' +
    '(3) Write 3-6 tight sentences, board-ready prose, leading with net income (if given) then the largest drivers. No markdown, no headings, no bullet list — just the paragraph.';

  const prompt = `FACTS (already computed — phrase these, do not alter):\n\n${facts}\n\nWrite the flux narrative now.`;

  const admin = createAdminSupabase();
  let gw;
  try {
    gw = await runAiGateway(
      { supabase: admin, anthropicApiKey: apiKey },
      {
        tenant_id: ctx.orgId ?? '',
        user_id: ctx.userId,
        module: 'BOOKS',
        feature: NARRATIVE_FEATURE,
        model: NARRATIVE_MODEL,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        max_tokens: 500,
      },
    );
  } catch (e) {
    return NextResponse.json({
      narrative: deterministicNarrative(variance),
      drivers: responseDrivers,
      citations,
      meta: { report: body.report, source: 'deterministic', model: null, decisionId: null, budgetState: 'under', message: e instanceof Error ? e.message : 'Gateway error' },
    });
  }

  if (gw.status === 'blocked' || gw.result == null) {
    return NextResponse.json({
      narrative: deterministicNarrative(variance),
      drivers: responseDrivers,
      citations,
      meta: { report: body.report, source: 'deterministic', model: gw.model_used, decisionId: null, budgetState: gw.budget.state, message: gw.message ?? 'AI request blocked' },
    });
  }

  const text = extractText(gw.result);
  const narrative = (text ?? '').trim() || deterministicNarrative(variance);

  // 3. Audit the AI proposal to the existing decision-log rail (org-scoped, RLS).
  let decisionId: string | null = null;
  try {
    const { data } = await ctx.supabase
      .from('ai_decisions')
      .insert({
        org_id: ctx.orgId,
        feature: NARRATIVE_FEATURE,
        model_requested: NARRATIVE_MODEL,
        model_used: gw.model_used,
        correlation_id: gw.correlation_id,
        input_summary: `Flux narrative — ${reportLabel}: ${labelA} vs ${labelB}`.slice(0, 2000),
        proposed_output: { narrative, drivers: responseDrivers, citations },
        reasoning: 'AI phrasing of deterministically-computed variances; figures authored in code, not by the model.',
        status: 'PROPOSED',
        tokens_input: gw.tokens.input,
        tokens_output: gw.tokens.output,
        cost_cents: gw.cost_cents,
        created_by_user: ctx.userId,
      })
      .select('id')
      .single();
    decisionId = (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[reports-narrative] decision log failed (non-fatal):', e);
  }

  return NextResponse.json({
    narrative,
    drivers: responseDrivers,
    citations,
    meta: {
      report: body.report,
      source: 'ai',
      model: gw.model_used,
      decisionId,
      budgetState: gw.budget.state,
      costCents: gw.cost_cents,
      message: gw.message,
    },
  });
});
