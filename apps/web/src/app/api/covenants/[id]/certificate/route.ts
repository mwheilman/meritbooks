export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { runAiGateway } from '@meritbooks/core-ai';
import { formatMoney } from '@meritbooks/shared';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { buildCovenantStatus, type CovenantRow, type CovenantStatus } from '@/lib/covenants/status';
import { certificateSchema } from '@/lib/covenants/schema';
import { BAND_LABEL } from '@/lib/covenants/compute';

/**
 * POST /api/covenants/[id]/certificate — draft the compliance certificate.
 *
 * Canon §3 boundary: EVERY number in the certificate is computed deterministically
 * from the ledger (buildCovenantStatus). The Core AI gateway (feature
 * COVENANT_DRIFT) is asked ONLY to phrase those already-computed facts into the
 * certificate narrative + a short drift explanation — it never computes or alters
 * a ratio. If the gateway is unavailable/blocked, a deterministic template
 * certificate is returned so the action always produces a truthful draft. The
 * draft is logged to the ai_decisions rail (PROPOSED) for human sign-off.
 */

const FEATURE = 'COVENANT_DRIFT';
const MODEL = 'claude-sonnet-4-20250514';

const SELECT =
  'id, location_id, loan_name, facility, lender_name, covenant_type, threshold, direction, ' +
  'test_frequency, warn_headroom_pct, measurement, status, effective_date, maturity_date, notes, ' +
  'created_at, updated_at';

interface Params {
  params: { id: string };
}

const SYSTEM =
  'You are a corporate controller drafting a lender compliance certificate. You are given covenant ' +
  'test results that have ALREADY been computed from the general ledger. STRICT RULES: ' +
  '(1) Use ONLY the figures provided — never invent, recompute, round differently, or introduce any ' +
  'number not in the facts. (2) State plainly whether each covenant is in compliance, and if a ' +
  'projected breach date is given, note it as a forward-looking estimate off the cash forecast. ' +
  '(3) Formal, factual, board/lender tone. No markdown headings — return: a one-paragraph certificate ' +
  'statement, then a blank line, then a 2-3 sentence "Commentary" on the drift/headroom. ' +
  'Do not speculate about causes the data does not contain.';

function unitOf(s: CovenantStatus): 'RATIO' | 'CURRENCY' {
  return s.evaluation.unit;
}
function valLabel(s: CovenantStatus, v: number | null): string {
  if (v === null) return 'n/a';
  return unitOf(s) === 'CURRENCY' ? formatMoney(Math.round(v * 100)) : `${v.toFixed(2)}x`;
}

function buildFacts(s: CovenantStatus, asOfNote?: string): string {
  const c = s.covenant;
  const e = s.evaluation;
  const comp = s.components;
  const proj = s.breach.crossingDate ?? s.breach.breachDate;
  const lines = [
    `Borrower/facility: ${c.loan_name}${c.facility ? ` (${c.facility})` : ''}${c.lender_name ? `, lender ${c.lender_name}` : ''}`,
    `Covenant: ${c.covenant_type}, required ${e.direction === 'MIN' ? 'minimum' : 'maximum'} ${valLabel(s, e.threshold)}`,
    `Test date (as-of): ${s.periodEnd}${asOfNote ? ` — ${asOfNote}` : ''}`,
    `Measured value: ${valLabel(s, e.value)} (${BAND_LABEL[e.band]})`,
    e.headroomPct !== null ? `Headroom vs threshold: ${(e.headroomPct * 100).toFixed(1)}%` : 'Headroom: not computable',
    `Compliance status: ${e.passed === null ? 'NOT DETERMINABLE' : e.passed ? 'IN COMPLIANCE' : 'NOT IN COMPLIANCE'}`,
  ];
  // Component transparency (only the ones relevant to the type are meaningful, but
  // listing the drivers keeps the certificate auditable).
  lines.push(
    `Drivers (trailing ${comp.periodStart} → ${comp.periodEnd}): EBITDA ${formatMoney(comp.ebitdaCents)}, ` +
      `debt service ${formatMoney(comp.debtServiceCents)}, total/net debt ${formatMoney(comp.totalDebtCents)}/${formatMoney(comp.netDebtCents)}, ` +
      `current assets ${formatMoney(comp.currentAssetsCents)}, current liabilities ${formatMoney(comp.currentLiabilitiesCents)}, ` +
      `liquidity ${formatMoney(comp.liquidityCents)}, tangible net worth ${formatMoney(comp.tangibleNetWorthCents)}`,
  );
  if (proj) lines.push(`Forward projection off the cash forecast: covenant is projected to breach on ${proj}.`);
  else lines.push('Forward projection off the cash forecast: no breach projected within the horizon.');
  return lines.join('\n');
}

function deterministicCertificate(s: CovenantStatus): string {
  const c = s.covenant;
  const e = s.evaluation;
  const inOut = e.passed === null ? 'could not be determined from available ledger data' : e.passed ? 'in compliance with' : 'NOT in compliance with';
  const proj = s.breach.crossingDate ?? s.breach.breachDate;
  const stmt =
    `As of ${s.periodEnd}, ${c.loan_name}${c.facility ? ` (${c.facility})` : ''} is ${inOut} the ${c.covenant_type} covenant, ` +
    `which requires a ${e.direction === 'MIN' ? 'minimum' : 'maximum'} of ${valLabel(s, e.threshold)}. ` +
    `The measured value is ${valLabel(s, e.value)}${e.headroomPct !== null ? ` (headroom ${(e.headroomPct * 100).toFixed(1)}%)` : ''}.`;
  const commentary = proj
    ? `Commentary: On the current cash-forecast trajectory the covenant is projected to breach on ${proj}. Management should evaluate mitigating actions before the next test date.`
    : `Commentary: No breach is projected within the forecast horizon. Figures are computed from the general ledger and remain subject to period close.`;
  return `${stmt}\n\n${commentary}`;
}

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;

  let asOfNote: string | undefined;
  let periodEnd: string | undefined;
  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = certificateSchema.safeParse(raw ?? {});
    if (parsed.success) {
      asOfNote = parsed.data.as_of_note;
      periodEnd = parsed.data.period_end;
    }
  } catch {
    // empty body is fine
  }

  const { data, error } = await supabase.from('loan_covenants').select(SELECT).eq('id', params.id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message, code: 'INTERNAL_ERROR' }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });

  const status = await buildCovenantStatus(supabase, data as CovenantRow, periodEnd);
  const facts = buildFacts(status, asOfNote);

  // Try the gateway to PHRASE the facts; fall back deterministically.
  const apiKey = getAnthropicApiKey();
  let narrative = deterministicCertificate(status);
  let source: 'ai' | 'deterministic' = 'deterministic';
  let model: string | null = null;
  let correlationId: string | null = null;
  let budgetState: string | null = null;

  if (apiKey) {
    try {
      const admin = createAdminSupabase();
      const gw = await runAiGateway(
        { supabase: admin, anthropicApiKey: apiKey },
        {
          tenant_id: orgId ?? '',
          user_id: userId,
          module: 'BOOKS',
          feature: FEATURE,
          model: MODEL,
          system: SYSTEM,
          messages: [
            { role: 'user', content: [{ type: 'text', text: `FACTS (already computed — phrase these, do not alter):\n\n${facts}\n\nDraft the compliance certificate now.` }] },
          ],
          max_tokens: 600,
        },
      );
      budgetState = gw.budget.state;
      model = gw.model_used;
      correlationId = gw.correlation_id;
      if (gw.status !== 'blocked' && gw.result != null) {
        const text = extractText(gw.result);
        if (text && text.trim()) {
          narrative = text.trim();
          source = 'ai';
        }
      }
    } catch (e) {
      console.error('[covenants/certificate] gateway error (non-fatal):', e instanceof Error ? e.message : e);
    }
  }

  // Log the draft to the AI decision rail (PROPOSED) for human sign-off.
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        location_id: (data as CovenantRow).location_id,
        feature: FEATURE,
        model_requested: source === 'ai' ? MODEL : null,
        model_used: model,
        correlation_id: correlationId,
        input_summary: `Compliance certificate — ${(data as CovenantRow).loan_name} ${(data as CovenantRow).covenant_type} as of ${status.periodEnd}`.slice(0, 2000),
        proposed_output: {
          kind: 'compliance_certificate',
          covenant_id: params.id,
          narrative,
          band: status.evaluation.band,
          value: status.evaluation.value,
          threshold: status.evaluation.threshold,
          unit: status.evaluation.unit,
          period_end: status.periodEnd,
          projected_breach_date: status.breach.crossingDate ?? status.breach.breachDate,
        },
        reasoning: 'Certificate narrative drafted by AI from deterministically-computed covenant facts; every figure authored in code, not by the model.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[covenants/certificate] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    narrative,
    facts,
    status: {
      band: status.evaluation.band,
      value: status.evaluation.value,
      threshold: status.evaluation.threshold,
      unit: status.evaluation.unit,
      passed: status.evaluation.passed,
      headroomPct: status.evaluation.headroomPct,
      periodEnd: status.periodEnd,
      projectedBreachDate: status.breach.crossingDate ?? status.breach.breachDate,
    },
    meta: { source, model, decisionId, budgetState },
  });
}
