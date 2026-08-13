/**
 * Cap-table / operating-agreement parser — DROP-AND-PARSE equity extraction.
 *
 * Takes an uploaded operating agreement / cap table / shareholder register (PDF or
 * image → base64) and, THROUGH the Core AI gateway (`@meritbooks/core-ai`, feature
 * EQUITY_EXTRACT, metered to core.ai_usage_log, tenant budget enforced across the
 * combined suite), extracts the STRUCTURED ownership of ONE entity: its owners /
 * members, ownership % (or units), capital contributed, and class.
 *
 * Canon boundary (§2/§3): the AI PROPOSES facts — it never creates a holder or a
 * posting. The model returns JSON validated by the pure `normalizeEquityExtraction`
 * (enum mapping + blank-on-unknown + confidence flags); a human reviews/edits/
 * confirms, and only confirmed owners persist via the gated commit path. Anything
 * the model can't determine is left BLANK for the human — never guessed.
 *
 * `parseEquityDocument` makes the model call; the pure normalizer lives in
 * `normalize.ts` and is unit-tested with no gateway dependency. Degrade-safe: with
 * no key, the route falls back to the CSV / manual path (identical output shape).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { normalizeEquityExtraction } from './normalize';
import type { ProposedCapTable } from './types';

export const EQUITY_EXTRACT_FEATURE = 'EQUITY_EXTRACT';
export const EQUITY_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

export type ParseEquityResult =
  | {
      ok: true;
      capTable: ProposedCapTable;
      model: string;
      correlationId: string | null;
      extractionMs: number;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

const EXTRACTION_PROMPT = `You are an expert corporate/securities paralegal. Read this operating agreement, cap table, shareholder register, or subscription document and extract the OWNERSHIP structure of the ONE entity it capitalizes.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "cap_table": {
    "entity_form": "LLC | CORP | PARTNERSHIP | SOLE_PROP | OTHER — the legal form of the entity",
    "owners": [
      {
        "name": "string — the owner / member / shareholder legal name",
        "ownership_pct": number or null — ownership as a PERCENT (25 for 25%), null if the doc states units/shares instead,
        "units": number or null — units / shares / membership interests held, null if the doc states a percent instead,
        "capital": number or null — capital contributed to date in WHOLE DOLLARS (not cents), null if not stated,
        "class": "COMMON | PREFERRED | LLC_UNIT | PARTNER | OTHER — the equity class",
        "is_preferred": true or false,
        "preferred_terms": {
          "liquidation_preference": number or null — the multiple (1 for 1x),
          "dividend_rate": number or null — as a PERCENT (8 for 8%),
          "participating": true or false or null,
          "seniority": "string or null — series/rank label, e.g. 'Series A'"
        },
        "confidence": { "name": 0-1, "ownership_pct": 0-1, "units": 0-1, "capital": 0-1 }
      }
    ],
    "snippet": "string — a short VERBATIM excerpt stating the ownership split, for traceability",
    "document_note": "string or null — anything unusual (multiple classes, illegible, draft, options/warrants excluded)"
  }
}

Rules:
- If a field is not stated, use null and set its confidence to 0. NEVER invent a value.
- Capital in WHOLE DOLLARS. Ownership as a percent number (25, not 0.25).
- List EVERY owner/member you can find. Options, warrants, and unissued authorized shares are NOT owners — note them in document_note if material.
- If ownership is stated in units/shares, fill "units" and leave "ownership_pct" null (we derive the percent).`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded cap-table / operating-agreement document into a proposed cap
 * table THROUGH the Core AI gateway (metered, budget-capped per tenant; `orgId`
 * scopes it, `userId` attributes it). Accepts base64-encoded PDF or image. Never
 * throws for expected failure cases — returns `{ ok: false, ... }` so callers
 * degrade to the CSV / manual path cleanly.
 */
export async function parseEquityDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParseEquityResult> {
  const { supabase, anthropicApiKey } = deps;
  const { orgId, userId, base64Data, mediaType } = args;
  const startTime = Date.now();

  const isPdf = mediaType === 'application/pdf';
  const isImage = mediaType.startsWith('image/');
  if (!isPdf && !isImage) {
    return { ok: false, error: `Unsupported file type: ${mediaType}. Must be PDF or image.` };
  }

  const contentBlock = isPdf
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: base64Data } }
    : {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: base64Data,
        },
      };

  let gw;
  try {
    gw = await runAiGateway(
      { supabase, anthropicApiKey },
      {
        tenant_id: orgId,
        user_id: userId ?? null,
        module: 'BOOKS',
        feature: EQUITY_EXTRACT_FEATURE,
        model: EQUITY_EXTRACT_MODEL,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: EXTRACTION_PROMPT }] }],
        max_tokens: 3000,
      },
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Gateway error' };
  }

  if (gw.status === 'blocked' || gw.result == null) {
    return { ok: false, error: gw.message ?? 'AI request blocked', budgetBlocked: gw.status === 'blocked' };
  }

  const text = extractText(gw.result);
  if (!text) return { ok: false, error: 'Model returned an empty response' };

  const jsonStr = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.error('[equity-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const capTable = normalizeEquityExtraction(parsed);

  return {
    ok: true,
    capTable,
    model: gw.model_used ?? EQUITY_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
  };
}
