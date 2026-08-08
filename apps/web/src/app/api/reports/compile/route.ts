export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runAiGateway } from '@meritbooks/core-ai';
import { apiHandler, type ApiContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import {
  expandParse,
  compilerAbstainMessage,
  REPORT_CATALOG,
  type ResolvedSpec,
} from '@/lib/reports/compiler/spec';
import {
  buildCompilerPrompt,
  validateCompilerOutput,
  COMPILER_SYSTEM,
  COMPILER_FEATURE,
} from '@/lib/reports/compiler/parse';

/**
 * POST /api/reports/compile — the NL Report Compiler PARSE step.
 *
 * Takes a plain-English request ("last three years of P&L and balance sheets on
 * accrual, in one PDF") and returns the RESOLVED report specs for the user to
 * CONFIRM before any PDF is produced. RLS-scoped (ctx.supabase) and safe by
 * construction:
 *   - The model only maps the sentence to allowlisted report types + basis +
 *     relative period descriptors (see lib/reports/compiler/parse.ts). It never
 *     computes a date or a number.
 *   - The org's fiscal_year_start_month is read (RLS) and the DETERMINISTIC
 *     expander turns the descriptors into concrete date ranges here.
 *   - Off-allowlist / empty → ABSTAIN with a helpful message; never a guess.
 *
 * The actual figures are produced later, deterministically, by
 * POST /api/reports/compile/pdf from the confirmed specs.
 */

const COMPILER_MODEL = 'claude-sonnet-4-20250514';

interface GatewayMeta {
  status: string;
  result: unknown;
  message?: string | null;
  correlation_id?: string | null;
  model_used?: string | null;
  cost_cents?: number | null;
  tokens?: { input?: number | null; output?: number | null } | null;
  budget?: { state?: string | null } | null;
}

const schema = z.object({
  prompt: z.string().min(2).max(2000),
  entity_label: z.string().max(200).optional(),
  location_ids: z.array(z.string().max(80)).max(50).optional(),
});

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const block = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return block?.text ?? null;
}

export const POST = apiHandler(schema, async (body, ctx: ApiContext) => {
  const { orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization in session', code: 'NO_ORG' }, { status: 400 });
  }

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'AI provider is not configured, so the report compiler is unavailable.', code: 'AI_UNAVAILABLE' },
      { status: 503 },
    );
  }

  // Fiscal-year config (RLS returns only the caller's org). Default calendar-year.
  let fyStartMonth = 1;
  try {
    const { data: org } = await ctx.supabase.from('organizations').select('fiscal_year_start_month').eq('id', orgId).maybeSingle();
    const m = Number((org as { fiscal_year_start_month?: number } | null)?.fiscal_year_start_month ?? 1);
    if (Number.isInteger(m) && m >= 1 && m <= 12) fyStartMonth = m;
  } catch {
    /* degrade to calendar year */
  }

  // 1. AI PARSE — mapping only, metered through the Core AI gateway.
  let gw: GatewayMeta;
  try {
    gw = (await runAiGateway(
      { supabase: createAdminSupabase(), anthropicApiKey: apiKey },
      {
        tenant_id: orgId,
        user_id: ctx.userId,
        module: 'BOOKS',
        feature: COMPILER_FEATURE,
        model: COMPILER_MODEL,
        system: COMPILER_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildCompilerPrompt(body.prompt) }] }],
        max_tokens: 900,
      },
    )) as unknown as GatewayMeta;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Gateway error', code: 'GATEWAY_ERROR' },
      { status: 502 },
    );
  }

  if (gw.status === 'blocked' || gw.result == null) {
    return NextResponse.json(
      { abstained: true, message: gw.message ?? 'The AI request was blocked (budget or policy). Try again shortly.', supported: supportedList() },
      { status: 200 },
    );
  }

  const text = extractText(gw.result);
  const validated = text ? validateCompilerOutput(text) : ({ ok: false, reason: 'empty model output' } as const);

  if (!validated.ok) {
    return NextResponse.json(
      { abstained: true, message: compilerAbstainMessage(), reason: validated.reason, supported: supportedList() },
      { status: 200 },
    );
  }

  // 2. DETERMINISTIC EXPANSION — descriptors → concrete date ranges.
  const specs: ResolvedSpec[] = expandParse(validated.parse, fyStartMonth);
  if (specs.length === 0) {
    return NextResponse.json(
      { abstained: true, message: compilerAbstainMessage(), reason: 'no periods resolved', supported: supportedList() },
      { status: 200 },
    );
  }

  const entityLabel =
    body.entity_label && body.entity_label.trim() ? body.entity_label.trim() : 'All Companies (Consolidated)';
  const locationIds = body.location_ids ?? [];

  // Best-effort audit of the AI proposal (non-fatal), RLS-scoped.
  try {
    await ctx.supabase.from('ai_decisions').insert({
      org_id: orgId,
      feature: COMPILER_FEATURE,
      model_requested: COMPILER_MODEL,
      model_used: gw.model_used,
      correlation_id: gw.correlation_id,
      input_summary: `Report compiler: ${body.prompt}`.slice(0, 2000),
      proposed_output: { specs },
      reasoning: 'AI mapped the request to allowlisted report specs; dates expanded deterministically, figures produced by the ledger engines.',
      status: 'PROPOSED',
      tokens_input: gw.tokens?.input ?? null,
      tokens_output: gw.tokens?.output ?? null,
      cost_cents: gw.cost_cents ?? null,
      created_by_user: ctx.userId,
    });
  } catch (e) {
    console.error('[compile] decision log failed (non-fatal):', e);
  }

  const totalSections = specs.reduce((n, s) => n + s.periods.length, 0);

  return NextResponse.json({
    abstained: false,
    pack: { entityLabel, locationIds, specs },
    // The RELATIVE descriptors (pre-expansion) so the client can SAVE a pack that
    // re-resolves to current dates on every future run — never frozen dates.
    descriptors: validated.parse.reports,
    summary: specs.map((s) => ({
      report: REPORT_CATALOG[s.report].title,
      basis: s.basis === 'CASH' && !s.cashWarning ? 'Cash' : 'Accrual',
      periods: s.periods.map((p) => p.label),
      cashWarning: s.cashWarning ?? null,
    })),
    totalSections,
    gateway: {
      status: gw.status,
      modelUsed: gw.model_used ?? null,
      costCents: gw.cost_cents ?? null,
      budgetState: gw.budget?.state ?? null,
      correlationId: gw.correlation_id ?? null,
    },
  });
});

function supportedList(): string[] {
  return (Object.keys(REPORT_CATALOG) as Array<keyof typeof REPORT_CATALOG>).map((k) => REPORT_CATALOG[k].title);
}
