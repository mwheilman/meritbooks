/**
 * Dealer imports — AI document readers THROUGH the Core AI gateway (SERVER-ONLY).
 *
 *   DEALER_LENDER_STATEMENT_PARSE  (FPB A1)  lender statement / floor check / payoff quote
 *   DEALER_OEM_STATEMENT_PARSE     (FPB A2)  manufacturer statement / credit memo
 *   DEALER_DEAL_RECAP_PARSE        (FPB A4)  deal recap / buyer's order → draft sale + trade
 *   DEALER_UNIT_LIST_PARSE                   dealer-system unit / stock list → units
 *   DEALER_PROGRAM_PARSE           (FPB A6)  manufacturer program bulletin → DRAFT programs
 *
 * Canon §2/§3: every call goes through `runAiGateway` (`@meritbooks/core-ai`) — metered to
 * core.ai_usage_log, counted against the tenant's combined monthly budget; the key comes
 * only from getAnthropicApiKey() and is injected into the gateway. The AI proposes FACTS
 * (parsed lines). It never writes a row, a balance or a status: the model's JSON is
 * normalized by the PURE ./ai-normalize.ts, a person reviews it, and only then do the D1
 * routes create PROPOSED rows. Prompts are generic — no lender, manufacturer or
 * dealer-system names — and tell the model to leave unknowns null.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { isAiUnavailableError } from '@/lib/ai/gateway';
import type { ImportFileKind } from '../types';
import { extractJson, normalizeForKind, type AiProposal } from './ai-normalize';

export const DEALER_LENDER_STATEMENT_PARSE = 'DEALER_LENDER_STATEMENT_PARSE';
export const DEALER_OEM_STATEMENT_PARSE = 'DEALER_OEM_STATEMENT_PARSE';
export const DEALER_DEAL_RECAP_PARSE = 'DEALER_DEAL_RECAP_PARSE';
export const DEALER_UNIT_LIST_PARSE = 'DEALER_UNIT_LIST_PARSE';
export const DEALER_PROGRAM_PARSE = 'DEALER_PROGRAM_PARSE';
export const DEALER_IMPORT_PARSE_MODEL = 'claude-sonnet-4-6';

/** The AI task for an import kind; null = no AI reader (use CSV / Excel). */
export function aiFeatureForKind(kind: ImportFileKind): string | null {
  switch (kind) {
    case 'LENDER_STATEMENT':
    case 'LENDER_AUDIT':
      return DEALER_LENDER_STATEMENT_PARSE;
    case 'OEM_STATEMENT':
      return DEALER_OEM_STATEMENT_PARSE;
    case 'DEALS':
      return DEALER_DEAL_RECAP_PARSE;
    case 'UNITS':
    case 'OPENING':
      return DEALER_UNIT_LIST_PARSE;
    case 'PROGRAMS':
      return DEALER_PROGRAM_PARSE;
    case 'WARRANTY':
      return null;
  }
}

const COMMON_RULES = `Rules:
- Return ONLY valid JSON (no markdown, no prose) in exactly the shape shown.
- Amounts are in DOLLARS as plain numbers (e.g. 12345.67) — not cents, no currency symbols.
- Dates are YYYY-MM-DD. If only month/day are printed, infer the year from the document's own date.
- If a value is not printed, use null. NEVER invent, estimate or calculate a value that is not on the document.
- "confidence" is 0-1: how sure you are that you read that row correctly.
- Do not include subtotal or total rows as lines; put totals only where the shape asks for them.`;

const PROMPTS: Record<string, string> = {
  [DEALER_LENDER_STATEMENT_PARSE]: `You are reading a floor-plan lender's document for an equipment dealer: a monthly statement, a floor check (audit) report, or a payoff quote. It may be a PDF, an image, a spreadsheet converted to text, or the body of an email with an inline table.

Return JSON:
{
  "statement": {
    "kind": "STATEMENT | AUDIT | PAYOFF_QUOTE | null",
    "statement_date": "YYYY-MM-DD or null — the statement / audit / quote date",
    "totals": {
      "principal": number or null — the TOTAL current principal printed on the document,
      "interest": number or null — the total interest printed, if any,
      "fees": number or null — the total fees printed, if any,
      "line_count": integer or null — the number of units/lines the document says it lists, if printed
    }
  },
  "lines": [
    {
      "invoice_number": "string or null — the lender's invoice / note / flooring number",
      "serial_number": "string or null — the unit serial / VIN / HIN",
      "model": "string or null",
      "original_amount": number or null — the original floored amount,
      "current_balance": number or null — the current principal owed on this line,
      "interest": number or null,
      "fees": number or null,
      "status_code": "string or null — any status / audit code printed for the line (e.g. a sold-and-unpaid code)",
      "disposition_date": "YYYY-MM-DD or null — sold / paid date if printed",
      "days": integer or null — days floored if printed,
      "confidence": number
    }
  ],
  "document_note": "string or null — anything unusual (illegible, several lines of credit mixed, totals missing)"
}

${COMMON_RULES}
- Copy every unit line. The lines' current balances should add up to the printed principal total; do NOT adjust any number to make them add up.`,

  [DEALER_OEM_STATEMENT_PARSE]: `You are reading a manufacturer's statement of account or a credit memo sent to an equipment dealer. Lines can be warranty claim credits, incentive / rebate / program credits, debits or chargebacks, parts invoices, or other items.

Return JSON:
{
  "document": {
    "type": "STATEMENT | CREDIT_MEMO",
    "statement_date": "YYYY-MM-DD or null",
    "total": number or null — the document's printed net total (credits positive, debits negative)
  },
  "lines": [
    {
      "line_type": "WARRANTY_CREDIT | INCENTIVE_CREDIT | DEBIT | PARTS_INVOICE | OTHER",
      "reference": "string or null — the claim number, program claim reference or document number exactly as printed",
      "serial_number": "string or null",
      "description": "string or null",
      "amount": number — SIGNED: a credit to the dealer is POSITIVE; a debit, chargeback or invoice the dealer owes is NEGATIVE,
      "confidence": number
    }
  ],
  "document_note": "string or null"
}

${COMMON_RULES}`,

  [DEALER_DEAL_RECAP_PARSE]: `You are reading an equipment dealer's deal recap, buyer's order or retail sales contract (one or more deals).

Return JSON:
{
  "deals": [
    {
      "deal_number": "string or null — the deal / contract / buyer's order number",
      "sale_date": "YYYY-MM-DD or null",
      "unit_serial": "string or null — serial / VIN / HIN of the unit sold",
      "customer_name": "string or null — the buyer exactly as printed",
      "sale_price": number or null — the unit's selling price before tax and before any trade,
      "sales_tax": number or null,
      "retail_rebate": number or null — a manufacturer rebate applied to the customer's price, if any,
      "salesperson": "string or null",
      "trade": null or {
        "serial_number": "string or null",
        "model": "string or null",
        "year": integer or null,
        "allowance": number or null — the trade allowance given to the customer,
        "acv": number or null — the trade's actual cash value, only if printed,
        "lien_payoff": number or null — any lien payoff on the trade
      },
      "confidence": number
    }
  ],
  "document_note": "string or null"
}

${COMMON_RULES}
- Do NOT treat the trade allowance as the ACV. Leave "acv" null unless an actual cash value is printed.`,

  [DEALER_UNIT_LIST_PARSE]: `You are reading an equipment dealer's unit inventory / stock list exported from its dealer management system.

Return JSON:
{
  "units": [
    {
      "serial_number": "string or null",
      "stock_number": "string or null",
      "vin_hin": "string or null",
      "make": "string or null — manufacturer / brand",
      "model": "string or null",
      "model_year": integer or null,
      "description": "string or null",
      "condition": "NEW | USED | DEMO | RENTAL | null",
      "status": "IN_STOCK | IN_TRANSIT | ON_ORDER | null",
      "received_date": "YYYY-MM-DD or null",
      "list_price": number or null,
      "dealer_cost": number or null — the dealer's invoice cost, if printed,
      "confidence": number
    }
  ],
  "document_note": "string or null"
}

${COMMON_RULES}`,

  [DEALER_PROGRAM_PARSE]: `You are reading a manufacturer's dealer program bulletin (rebates, incentives, bonuses, co-op, floor-plan support).

Return JSON:
{
  "programs": [
    {
      "program_code": "string or null",
      "name": "string or null",
      "program_type": "RETAIL_REBATE | DEALER_REBATE | VOLUME_BONUS | HOLDBACK | CO_OP | SPIFF | INTEREST_SUBSIDY | FLOOR_PLAN_SUPPORT | DEMO_SUPPORT | OTHER | null",
      "treatment": null,
      "paid_direct": boolean or null — true when the manufacturer pays the customer directly,
      "start_date": "YYYY-MM-DD or null",
      "end_date": "YYYY-MM-DD or null",
      "claim_deadline_days": integer or null — days after the sale/delivery allowed to claim,
      "amount_per_unit": number or null,
      "eligible_models": "string or null",
      "notes": "string or null — eligibility rules and conditions in one or two sentences",
      "confidence": number
    }
  ],
  "document_note": "string or null"
}

${COMMON_RULES}
- Always leave "treatment" null — the accounting treatment is decided by a person.`,
};

export type DealerAiInput =
  | { type: 'pdf'; base64: string }
  | { type: 'image'; base64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }
  | { type: 'text'; text: string; label: string };

export type DealerAiResult =
  | { ok: true; proposal: AiProposal; feature: string; model: string; correlationId: string | null; ms: number }
  | { ok: false; error: string; unavailable?: boolean; budgetBlocked?: boolean; unsupported?: boolean };

const MAX_TEXT = 150_000;

function textOf(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const parts = (result as Array<{ type?: string; text?: string }>).filter((c) => c?.type === 'text' && typeof c.text === 'string');
  return parts.length ? parts.map((p) => p.text).join('') : null;
}

/**
 * Read one dealer document into a normalized proposal. Never throws for the expected
 * failures: AI account unavailable → `{ unavailable: true }`, budget → `{ budgetBlocked }`.
 */
export async function parseDealerDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId: string | null; kind: ImportFileKind; input: DealerAiInput },
): Promise<DealerAiResult> {
  const feature = aiFeatureForKind(args.kind);
  if (!feature) return { ok: false, unsupported: true, error: 'There is no document reader for this kind of import — use CSV or Excel.' };
  const started = Date.now();
  const prompt = PROMPTS[feature];

  const content =
    args.input.type === 'pdf'
      ? [{ type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: args.input.base64 } }, { type: 'text' as const, text: prompt }]
      : args.input.type === 'image'
        ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: args.input.mediaType, data: args.input.base64 } }, { type: 'text' as const, text: prompt }]
        : [{ type: 'text' as const, text: `${prompt}\n\n--- ${args.input.label} ---\n${args.input.text.slice(0, MAX_TEXT)}` }];

  let gw;
  try {
    gw = await runAiGateway(
      deps,
      {
        tenant_id: args.orgId,
        user_id: args.userId,
        module: 'BOOKS',
        feature,
        model: DEALER_IMPORT_PARSE_MODEL,
        messages: [{ role: 'user', content }],
        max_tokens: 16000,
      },
    );
  } catch (e) {
    if (isAiUnavailableError(e)) return { ok: false, unavailable: true, error: e instanceof Error ? e.message : 'AI unavailable' };
    return { ok: false, error: e instanceof Error ? e.message : 'AI gateway error' };
  }
  if (gw.status === 'blocked' || gw.result == null) {
    return { ok: false, budgetBlocked: gw.status === 'blocked', error: gw.message ?? 'AI request blocked' };
  }
  const text = textOf(gw.result);
  if (!text) return { ok: false, error: 'The AI returned an empty response' };
  const json = extractJson(text);
  if (json == null) return { ok: false, error: 'The AI response could not be read' };
  const proposal = normalizeForKind(args.kind, json);
  if (!proposal) return { ok: false, unsupported: true, error: 'There is no document reader for this kind of import.' };
  return {
    ok: true,
    proposal,
    feature,
    model: gw.model_used ?? DEALER_IMPORT_PARSE_MODEL,
    correlationId: gw.correlation_id ?? null,
    ms: Date.now() - started,
  };
}
