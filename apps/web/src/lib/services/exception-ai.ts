/**
 * AI exception predictor (GATE 3) — capex / prepaid / deferred-revenue detection
 * routed through the metered Core AI gateway, with an immutable decision-log row.
 *
 * This is the AI counterpart to the deterministic, regex-based `predictException`
 * (posting/exception-predictor.ts, exposed at POST /api/posting/predict). The
 * deterministic predictor stays the free default; this one is the metered,
 * budget-capped, decision-logged path that uses the model's judgment on
 * ambiguous substance and can ask ONE clarifying question.
 *
 * The verdict uses the SAME treatment vocabulary the rest of the engine already
 * consumes — EXPENSE | CAPITALIZE | PREPAID | DEFERRED_REVENUE — so it feeds the
 * GATE 2 provisioning path unchanged:
 *   CAPITALIZE        -> recordAssetAcquisition  (fixed asset + depreciation schedule)
 *   PREPAID           -> recordPrepaidPurchase   (prepaid asset + amortization schedule)
 *   DEFERRED_REVENUE  -> recordDeferredRevenue   (contract liability + recognition schedule)
 *   EXPENSE           -> (none; book as a normal expense)
 *
 * Advisory only: it proposes a treatment; a human approves before any schedule is
 * created. If the gateway is unavailable or budget-blocked, it returns the
 * deterministic verdict so callers never lose the advisory entirely.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { predictException, type ExceptionTreatment } from '../posting/exception-predictor';

export const EXCEPTION_MODEL = 'claude-sonnet-4-20250514';
export const EXCEPTION_FEATURE = 'EXCEPTION_PREDICTION';

/** Maps a treatment to the GATE 2 provisioning entry point that creates its schedule. */
export const PROVISIONING_ACTION: Record<ExceptionTreatment, string | null> = {
  EXPENSE: null,
  CAPITALIZE: 'recordAssetAcquisition',
  PREPAID: 'recordPrepaidPurchase',
  DEFERRED_REVENUE: 'recordDeferredRevenue',
};

export interface AiExceptionVerdict {
  treatment: ExceptionTreatment;
  flag: boolean; // treatment !== 'EXPENSE'
  confidence: number;
  reason: string;
  suggestedAmortizationMonths: number | null;
  thresholdCents: number | null;
  clarifyingQuestion: string | null;
  /** Which provisioning function commits this treatment (null for EXPENSE). */
  provisioningAction: string | null;
  source: 'ai' | 'deterministic';
  decisionId: string | null;
}

export interface AiExceptionGatewayMeta {
  status: string;
  modelRequested: string;
  modelUsed: string | null;
  costCents: number;
  correlationId: string;
  budgetState: string;
  message: string | null;
}

export interface AiExceptionInput {
  orgId: string;
  userId: string | null;
  locationId: string;
  accountId: string;
  amountCents: number;
  description?: string;
  side?: 'expense' | 'revenue';
}

export type AiExceptionResult =
  | { ok: true; verdict: AiExceptionVerdict; gateway: AiExceptionGatewayMeta | null }
  | { ok: false; error: string; budgetBlocked?: boolean; verdict: AiExceptionVerdict };

interface AccountMeta {
  account_number: string;
  name: string;
  account_type: string;
  account_sub_type: string;
}

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

function toVerdict(
  treatment: ExceptionTreatment,
  confidence: number,
  reason: string,
  months: number | null,
  thresholdCents: number | null,
  clarifyingQuestion: string | null,
  source: 'ai' | 'deterministic',
  decisionId: string | null,
): AiExceptionVerdict {
  return {
    treatment,
    flag: treatment !== 'EXPENSE',
    confidence: Math.min(1, Math.max(0, confidence)),
    reason,
    suggestedAmortizationMonths: months,
    thresholdCents,
    clarifyingQuestion,
    provisioningAction: PROVISIONING_ACTION[treatment],
    source,
    decisionId,
  };
}

/**
 * Suggest a balance-sheet treatment through the gateway. Always returns a verdict:
 * the AI verdict on success, otherwise the deterministic one (so the advisory is
 * never lost). Writes an ai_decisions row only for genuine AI proposals.
 */
export async function suggestExceptionViaGateway(
  supabase: SupabaseClient,
  anthropicApiKey: string,
  input: AiExceptionInput,
): Promise<AiExceptionResult> {
  // 1. Deterministic baseline — gives us the company policy threshold + default
  //    amortization months, and is our fallback if the gateway can't run.
  const baseline = await predictException(supabase, {
    orgId: input.orgId,
    locationId: input.locationId,
    accountId: input.accountId,
    amountCents: input.amountCents,
    description: input.description,
    side: input.side,
  });
  const baselineVerdict = toVerdict(
    baseline.treatment,
    baseline.flag ? 0.6 : 0.7,
    baseline.reason,
    baseline.suggested_amortization_months ?? null,
    baseline.threshold_cents ?? null,
    null,
    'deterministic',
    null,
  );

  // 2. Account context for the prompt.
  const { data: acct } = await supabase
    .from('accounts')
    .select('account_number, name, account_type, account_sub_type')
    .eq('org_id', input.orgId)
    .eq('id', input.accountId)
    .maybeSingle<AccountMeta>();

  const desc = (input.description ?? '').trim();
  const side = input.side ?? 'expense';
  const thresholdStr =
    baseline.threshold_cents != null ? `$${(baseline.threshold_cents / 100).toLocaleString()}` : '(no policy threshold on file)';
  const defaultMonths = baseline.suggested_amortization_months ?? 12;

  const prompt = `You are a senior accountant deciding how to BOOK a transaction line under GAAP. Decide whether it is a normal expense or should be recorded on the balance sheet first.

TRANSACTION:
  Description: """${desc || '(none provided)'}"""
  Amount: $${(input.amountCents / 100).toFixed(2)}
  Side: ${side}
  Proposed GL account: ${acct ? `${acct.account_number} ${acct.name} (${acct.account_type}/${acct.account_sub_type})` : '(unknown)'}

COMPANY POLICY:
  Capitalization threshold: ${thresholdStr}
  Default amortization/recognition period: ${defaultMonths} months

CHOOSE ONE treatment:
  - EXPENSE          a normal period cost — book it straight to the expense/COGS account.
  - CAPITALIZE       a durable asset (useful life > 1 year) at or above the capitalization threshold — capitalize and depreciate.
  - PREPAID          a cost paid now that benefits future periods (annual insurance/software, prepaid rent, retainers, multi-period support) — record a prepaid asset and amortize.
  - DEFERRED_REVENUE (revenue side only) a customer deposit/advance/prepayment for work not yet performed — record a liability and recognize over time.

JUDGMENT RULES:
  - Substance over description. Do NOT capitalize routine repairs/supplies just because the amount is large; do NOT expense a clearly multi-period prepayment just because it is small.
  - If the economic substance is genuinely ambiguous, set "clarifying_question" to ONE specific question and still give your best-guess treatment.
  - This is ADVISORY; a human will confirm before anything posts.

Respond with ONLY this JSON, no markdown:
{"treatment":"EXPENSE|CAPITALIZE|PREPAID|DEFERRED_REVENUE","confidence":0.0,"reason":"one sentence","suggested_amortization_months":${defaultMonths},"clarifying_question":null}`;

  let gw;
  try {
    gw = await runAiGateway(
      { supabase, anthropicApiKey },
      {
        tenant_id: input.orgId,
        user_id: input.userId,
        module: 'BOOKS',
        feature: EXCEPTION_FEATURE,
        model: EXCEPTION_MODEL,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        max_tokens: 400,
      },
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gateway error', verdict: baselineVerdict };
  }

  const meta: AiExceptionGatewayMeta = {
    status: gw.status,
    modelRequested: EXCEPTION_MODEL,
    modelUsed: gw.model_used,
    costCents: gw.cost_cents,
    correlationId: gw.correlation_id,
    budgetState: gw.budget.state,
    message: gw.message,
  };

  if (gw.status === 'blocked' || gw.result == null) {
    return { ok: false, error: gw.message ?? 'AI request blocked', budgetBlocked: gw.status === 'blocked', verdict: baselineVerdict };
  }

  const text = extractText(gw.result);
  if (!text) return { ok: false, error: 'Empty AI response', verdict: baselineVerdict };

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
  } catch {
    return { ok: false, error: 'Could not parse the AI response', verdict: baselineVerdict };
  }

  const rawTreatment = String(parsed.treatment ?? 'EXPENSE').toUpperCase();
  const treatment: ExceptionTreatment = (['EXPENSE', 'CAPITALIZE', 'PREPAID', 'DEFERRED_REVENUE'].includes(rawTreatment)
    ? rawTreatment
    : 'EXPENSE') as ExceptionTreatment;
  const confidence = Math.min(1, Math.max(0, Number(parsed.confidence ?? 0)));
  const reason = String(parsed.reason ?? '');
  const months =
    parsed.suggested_amortization_months != null && Number.isFinite(Number(parsed.suggested_amortization_months))
      ? Math.max(1, Math.round(Number(parsed.suggested_amortization_months)))
      : treatment === 'PREPAID' || treatment === 'DEFERRED_REVENUE'
        ? defaultMonths
        : null;
  const clarifyingQuestion = parsed.clarifying_question ? String(parsed.clarifying_question) : null;

  // Decision log — every AI proposal is recorded before it can be acted on.
  let decisionId: string | null = null;
  try {
    const { data } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: input.orgId,
        location_id: input.locationId,
        feature: EXCEPTION_FEATURE,
        model_requested: EXCEPTION_MODEL,
        model_used: gw.model_used,
        correlation_id: gw.correlation_id,
        input_summary: `${desc || '(no description)'} ($${(input.amountCents / 100).toFixed(2)}, ${side})`.slice(0, 2000),
        proposed_output: {
          treatment,
          provisioning_action: PROVISIONING_ACTION[treatment],
          suggested_amortization_months: months,
          threshold_cents: baseline.threshold_cents ?? null,
          account_id: input.accountId,
          amount_cents: input.amountCents,
          side,
        },
        confidence,
        reasoning: reason,
        clarifying_question: clarifyingQuestion,
        status: 'PROPOSED',
        tokens_input: gw.tokens.input,
        tokens_output: gw.tokens.output,
        cost_cents: gw.cost_cents,
      })
      .select('id')
      .single();
    decisionId = (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[exception-ai] decision log failed (non-fatal):', e);
  }

  const verdict = toVerdict(
    treatment,
    confidence,
    reason,
    months,
    baseline.threshold_cents ?? null,
    clarifyingQuestion,
    'ai',
    decisionId,
  );

  return { ok: true, verdict, gateway: meta };
}
