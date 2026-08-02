/**
 * Subscription agreement parser — DROP-AND-PARSE extraction of the EXACT terms a
 * subscription agreement / order form carries: renewal date, notice period, auto-renew,
 * cancellation method, and price/cadence. THROUGH the Core AI gateway (@meritbooks/core-ai,
 * feature SUBSCRIPTION_EXTRACT, metered to core.ai_usage_log, tenant budget enforced
 * across the combined suite). No Anthropic key is held here.
 *
 * Canon boundary (§2/§3): the AI PROPOSES facts — it never writes the register or the
 * ledger. The model returns JSON validated + normalized here; the human reviews / edits /
 * confirms, and only confirmed terms persist via the gated create/patch paths (RLS + Zod).
 * Anything undeterminable is left BLANK for the human — never guessed. Money is cents.
 *
 * The model call lives in `parseAgreementDocument`; the pure normalizer
 * (`normalizeAgreementExtraction`, `mapCadence`, `dollarsToCentsOrNull`) is exported
 * separately and unit-tested with no gateway dependency.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { BILLING_CADENCES, type BillingCadence } from './detect';

export const SUBSCRIPTION_EXTRACT_FEATURE = 'SUBSCRIPTION_EXTRACT';
export const SUBSCRIPTION_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

/** Exact terms proposed from an agreement, mapped onto `subscriptions` fields. */
export interface ProposedTerms {
  vendor_name: string | null;
  product: string | null;
  category: string | null;
  amount_cents: number | null;
  billing_cadence: BillingCadence;
  next_renewal_date: string | null;
  auto_renews: boolean | null;
  notice_period_days: number | null;
  cancellation_method: string | null;
  cancellation_terms: string | null;
  notes: string | null;
  /** Verbatim excerpt for traceability. */
  snippet: string | null;
  confidence: Record<string, number>;
  lowConfidenceFields: string[];
}

export type ParseAgreementResult =
  | {
      ok: true;
      terms: ProposedTerms;
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

const LOW_CONFIDENCE = 0.6;

const EXTRACTION_PROMPT = `You are an expert contracts analyst. Extract the EXACT subscription terms from this
agreement / order form. Return ONLY a JSON object (no prose, no markdown fences):
{
  "vendor_name": string|null,       // the service provider / vendor
  "product": string|null,           // the plan / product / seat tier
  "category": string|null,          // software category (e.g. "CRM", "Cloud Hosting")
  "amount": number|null,            // recurring charge in DOLLARS (not cents)
  "billing_cadence": "MONTHLY"|"QUARTERLY"|"ANNUAL"|"OTHER"|null,
  "next_renewal_date": "YYYY-MM-DD"|null,  // next renewal / anniversary date
  "auto_renews": boolean|null,      // does it auto-renew?
  "notice_period_days": number|null,// days' notice required to cancel/non-renew
  "cancellation_method": string|null,// how to cancel (portal / email / written notice / phone)
  "cancellation_terms": string|null, // short summary of the cancellation clause
  "notes": string|null,
  "snippet": string|null,           // verbatim excerpt of the renewal/cancellation clause
  "confidence": { "<field>": 0..1 },// your confidence per field
  "document_note": string|null      // anything notable / ambiguous
}
Leave any field you cannot determine as null — never guess. Dollars, not cents.`;

// ── Pure normalizers (unit-tested; no gateway) ───────────────────────────────
export function dollarsToCentsOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 100);
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(n)) return Math.round(n * 100);
  }
  return null;
}

export function mapCadence(v: unknown): BillingCadence {
  const s = String(v ?? '').toUpperCase().trim();
  if ((BILLING_CADENCES as readonly string[]).includes(s)) return s as BillingCadence;
  if (/MONTH/.test(s)) return 'MONTHLY';
  if (/QUART/.test(s)) return 'QUARTERLY';
  if (/ANNUAL|YEAR/.test(s)) return 'ANNUAL';
  return 'OTHER';
}

function toStringOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

function toDateOrNull(v: unknown): string | null {
  const s = toStringOrNull(v);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function toIntOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(n)) return Math.round(n);
  }
  return null;
}

function toBoolOrNull(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    if (['true', 'yes', 'y'].includes(s)) return true;
    if (['false', 'no', 'n'].includes(s)) return false;
  }
  return null;
}

/** Normalize the model's JSON into a ProposedTerms with per-field confidence. Pure. */
export function normalizeAgreementExtraction(parsed: unknown): ProposedTerms {
  const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const confIn = (o.confidence && typeof o.confidence === 'object' ? o.confidence : {}) as Record<string, unknown>;

  const terms: Omit<ProposedTerms, 'confidence' | 'lowConfidenceFields'> = {
    vendor_name: toStringOrNull(o.vendor_name),
    product: toStringOrNull(o.product),
    category: toStringOrNull(o.category),
    amount_cents: dollarsToCentsOrNull(o.amount),
    billing_cadence: mapCadence(o.billing_cadence),
    next_renewal_date: toDateOrNull(o.next_renewal_date),
    auto_renews: toBoolOrNull(o.auto_renews),
    notice_period_days: toIntOrNull(o.notice_period_days),
    cancellation_method: toStringOrNull(o.cancellation_method),
    cancellation_terms: toStringOrNull(o.cancellation_terms),
    notes: toStringOrNull(o.notes),
    snippet: toStringOrNull(o.snippet),
  };

  // The model keys confidence by its JSON field names; the register keys by `*_cents`.
  const CONF_ALIAS: Record<string, string> = { amount: 'amount_cents' };
  const confidence: Record<string, number> = {};
  for (const [k, v] of Object.entries(confIn)) {
    const n = Number(v);
    if (Number.isFinite(n)) confidence[CONF_ALIAS[k] ?? k] = Math.max(0, Math.min(1, n));
  }

  const lowConfidenceFields = Object.keys(terms).filter((f) => {
    const c = confidence[f];
    const value = (terms as Record<string, unknown>)[f];
    return (typeof c === 'number' && c < LOW_CONFIDENCE) || value === null;
  });

  return { ...terms, confidence, lowConfidenceFields };
}

function extractText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// ── Gateway call ─────────────────────────────────────────────────────────────
export async function parseAgreementDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParseAgreementResult> {
  const { supabase, anthropicApiKey } = deps;
  const { orgId, userId, base64Data, mediaType } = args;
  const startTime = Date.now();

  const isPdf = mediaType === 'application/pdf';
  const isImage = mediaType.startsWith('image/');
  if (!isPdf && !isImage) return { ok: false, error: `Unsupported file type: ${mediaType}. Must be PDF or image.` };

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
        feature: SUBSCRIPTION_EXTRACT_FEATURE,
        model: SUBSCRIPTION_EXTRACT_MODEL,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: EXTRACTION_PROMPT }] }],
        max_tokens: 2000,
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
    console.error('[subscription-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const terms = normalizeAgreementExtraction(parsed);
  const documentNote =
    parsed && typeof parsed === 'object' ? toStringOrNull((parsed as { document_note?: unknown }).document_note) : null;

  return {
    ok: true,
    terms,
    model: gw.model_used ?? SUBSCRIPTION_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
