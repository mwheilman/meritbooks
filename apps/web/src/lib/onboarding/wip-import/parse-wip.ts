/**
 * WIP schedule / contracts parser — DROP-AND-PARSE job extraction.
 *
 * Takes an uploaded WIP schedule or contract set (PDF or image → base64) and, THROUGH
 * the Core AI gateway (feature WIP_EXTRACT, metered to core.ai_usage_log, tenant budget
 * enforced), extracts the STRUCTURED open-job facts mapped to `ProposedJob[]`.
 *
 * Canon boundary (§2/§3): the AI PROPOSES facts — it never creates a job, computes an
 * earned-revenue figure, or writes a schedule. The model returns JSON that is validated
 * by the pure `normalizeWipExtraction` (unit-tested, no gateway); the human
 * reviews/edits/confirms; only then does the commit path create jobs and stage the
 * opening WIP totals. Anything the model can't determine is left BLANK — never guessed.
 *
 * DEGRADE-SAFE: when the AI key is absent the gateway returns blocked and the caller
 * falls back to the deterministic CSV column-map importer, which is fully functional
 * on its own (design spec §5).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import type { ProposedJob } from './types';
import { normalizeWipExtraction } from './normalize';

export const WIP_EXTRACT_FEATURE = 'WIP_EXTRACT';
export const WIP_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

export type ParseWipResult =
  | {
      ok: true;
      jobs: ProposedJob[];
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

const EXTRACTION_PROMPT = `You are an expert construction controller. Read this Work-in-Progress (WIP) schedule / job-cost report / set of contracts and extract the OPEN jobs it lists.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "jobs": [
    {
      "job_number": "string — the job / contract number",
      "job_name": "string — the job / project name",
      "customer_name": "string or null — the owner / customer",
      "job_type": "string or null — e.g. CONSTRUCTION, HVAC, SERVICE",
      "original_contract": number or null — original contract value in WHOLE DOLLARS (not cents), before change orders,
      "change_orders": number or null — approved change orders total in WHOLE DOLLARS,
      "contract_value": number or null — CURRENT contract value in WHOLE DOLLARS including approved change orders (if stated directly),
      "estimated_cost": number or null — estimated total cost at completion (EAC) in WHOLE DOLLARS,
      "costs_to_date": number or null — actual cost incurred to date in WHOLE DOLLARS,
      "billed_to_date": number or null — amount billed to the customer to date in WHOLE DOLLARS,
      "retainage_receivable": number or null — retainage held back on OUR billings (receivable), WHOLE DOLLARS,
      "retainage_payable": number or null — retainage we hold back from subcontractors (payable), WHOLE DOLLARS,
      "customer_deposits": number or null — customer deposits / advances (a liability), WHOLE DOLLARS,
      "pct_complete": number or null — physical percent complete (0-100), only if explicitly stated,
      "cost_codes": [ { "code": "string", "label": "string or null", "cost_type": "LABOR|MATERIALS|SUBCONTRACTOR|EQUIPMENT|OTHER or null", "budget": number or null (WHOLE DOLLARS) } ] or null,
      "snippet": "string — a short VERBATIM excerpt for this job, for traceability",
      "confidence": { "contract_value": 0-1, "estimated_cost": 0-1, "costs_to_date": 0-1, "billed_to_date": 0-1 }
    }
  ],
  "document_note": "string or null — anything unusual (scanned/illegible, closed jobs excluded, totals row skipped)"
}

Rules:
- All money in WHOLE DOLLARS, never cents. If a field is not stated, use null and set its confidence to 0. NEVER invent a value.
- Extract only OPEN / active jobs. Skip completed/closed jobs and any totals/subtotal rows (note them in document_note).
- Do NOT compute earned revenue, over/under-billing, or percent complete from cost — only report figures the document states.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

function toStringOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s === '' ? null : s;
}

/**
 * Parse an uploaded WIP schedule / contracts document into ProposedJob[] THROUGH the
 * Core AI gateway (metered, budget-capped per tenant). Accepts base64 PDF or image.
 * Never throws for expected failures — returns `{ ok: false, ... }` so the caller can
 * degrade to the CSV importer.
 */
export async function parseWipDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParseWipResult> {
  const { supabase, anthropicApiKey } = deps;
  const { orgId, userId, base64Data, mediaType } = args;
  const startTime = Date.now();

  const isPdf = mediaType === 'application/pdf';
  const isImage = mediaType.startsWith('image/');
  if (!isPdf && !isImage) {
    return { ok: false, error: `Unsupported file type: ${mediaType}. Drop a PDF/image WIP schedule, or upload a CSV.` };
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
        feature: WIP_EXTRACT_FEATURE,
        model: WIP_EXTRACT_MODEL,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: EXTRACTION_PROMPT }] }],
        max_tokens: 4000,
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
    console.error('[wip-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const jobs = normalizeWipExtraction(parsed);
  const documentNote =
    parsed && typeof parsed === 'object'
      ? toStringOrNull((parsed as { document_note?: unknown }).document_note)
      : null;

  return {
    ok: true,
    jobs,
    model: gw.model_used ?? WIP_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
