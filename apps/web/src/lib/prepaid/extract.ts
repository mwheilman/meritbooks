/**
 * Prepaid-invoice extraction — DROP-AND-PARSE, THROUGH the Core AI gateway.
 *
 * Takes an uploaded prepaid invoice / agreement (PDF or image → base64) and, via
 * `@meritbooks/core-ai` (feature PREPAID_EXTRACT, metered to core.ai_usage_log,
 * tenant budget enforced across the combined suite), proposes the fields needed to
 * set up an amortization schedule: description, vendor, prepaid amount, the coverage
 * term (months and/or start + end date), and a suggested expense category name.
 *
 * Canon §3 boundary: the AI PROPOSES facts — it never creates a schedule or posts.
 * The model's loose JSON is validated + normalized by the pure, I/O-free
 * `normalizePrepaidExtraction` (exported + unit-testable), the human reviews/edits,
 * and only a confirmed schedule persists via the gated `POST /api/prepaid` path.
 * Anything undeterminable is left BLANK for the human — never guessed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';

export const PREPAID_EXTRACT_FEATURE = 'PREPAID_EXTRACT';
export const PREPAID_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

/** One proposed prepaid, ready to seed the setup form. Blank fields => human fills. */
export interface ProposedPrepaid {
  description: string | null;
  vendor_name: string | null;
  /** prepaid amount in bigint CENTS (model returns dollars; we convert). */
  total_cents: number | null;
  /** coverage term in whole months, when stated/derivable. */
  term_months: number | null;
  /** coverage start 'YYYY-MM-DD' or null. */
  start_date: string | null;
  /** coverage end 'YYYY-MM-DD' or null. */
  end_date: string | null;
  /** free-text expense category the model suggests (mapped to an account by the human). */
  expense_hint: string | null;
  /** per-field model confidence, 0..1. */
  confidence: Record<string, number>;
  /** fields the UI should highlight (low confidence or blank-but-needed). */
  lowConfidenceFields: string[];
  /** verbatim excerpt for traceability. */
  snippet: string | null;
}

export type ParsePrepaidResult =
  | {
      ok: true;
      prepaid: ProposedPrepaid;
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

const LOW_CONFIDENCE = 0.6;

function toStringOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s === '' ? null : s;
}

/** Dollars (string/number, tolerant of $ and commas) → integer cents, or null. */
export function dollarsToCentsOrNull(raw: unknown): number | null {
  let n: number | null = null;
  if (typeof raw === 'number') n = Number.isFinite(raw) ? raw : null;
  else if (typeof raw === 'string') {
    const cleaned = raw.replace(/[$,\s]/g, '');
    if (cleaned === '') return null;
    const parsed = Number(cleaned);
    n = Number.isFinite(parsed) ? parsed : null;
  }
  if (n === null || n <= 0) return null;
  return Math.round(n * 100);
}

function toIsoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y), month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return raw.trim();
}

function toMonthsOrNull(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const m = Math.round(n);
  if (m < 1 || m > 600) return null; // 1 month .. 50 years
  return m;
}

function conf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Whole months between two 'YYYY-MM-DD' dates, inclusive of partial end; null if unusable. */
export function monthsBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return null;
  const months = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
  return Math.max(1, months + (e.getUTCDate() >= s.getUTCDate() ? 1 : 0));
}

/**
 * Pure normalizer — turn the model's loose JSON into a validated ProposedPrepaid.
 * Never throws; a malformed shape yields an all-blank proposal the human completes.
 * Derives term from start/end when the model gave dates but not a month count.
 */
export function normalizePrepaidExtraction(raw: unknown): ProposedPrepaid {
  const r = (raw ?? {}) as Record<string, unknown>;

  const total_cents = dollarsToCentsOrNull(r.total_amount ?? r.amount ?? r.total);
  const start_date = toIsoDate(r.start_date ?? r.coverage_start ?? r.service_start);
  const end_date = toIsoDate(r.end_date ?? r.coverage_end ?? r.service_end);
  let term_months = toMonthsOrNull(r.term_months ?? r.months);
  if (term_months === null) term_months = monthsBetween(start_date, end_date);

  const c = (r.confidence ?? {}) as Record<string, unknown>;
  const confidence: Record<string, number> = {
    total: conf(c.total ?? c.amount),
    term: conf(c.term ?? c.term_months),
    dates: conf(c.dates ?? c.start_date),
    vendor: conf(c.vendor),
  };

  const low: string[] = [];
  if (total_cents === null) low.push('total');
  else if (confidence.total < LOW_CONFIDENCE) low.push('total');
  if (term_months === null) low.push('term');
  else if (confidence.term < LOW_CONFIDENCE) low.push('term');
  if (start_date === null) low.push('start_date');

  return {
    description: toStringOrNull(r.description ?? r.summary),
    vendor_name: toStringOrNull(r.vendor_name ?? r.vendor),
    total_cents,
    term_months,
    start_date,
    end_date,
    expense_hint: toStringOrNull(r.expense_category ?? r.expense_hint ?? r.category),
    confidence,
    lowConfidenceFields: Array.from(new Set(low)),
    snippet: toStringOrNull(r.snippet),
  };
}

const EXTRACTION_PROMPT = `You are an expert accountant reading a PREPAID expense document (an invoice or agreement paid up front and consumed over time — e.g. annual insurance, a software subscription, prepaid rent, a maintenance contract, a retainer).

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "description": "string or null — a short description (e.g. 'Annual liability insurance premium')",
  "vendor_name": "string or null — who was paid",
  "total_amount": number or null — the TOTAL prepaid amount in whole DOLLARS (not cents). null if not stated,
  "term_months": number or null — the coverage term in whole months if stated (e.g. an annual policy = 12),
  "start_date": "YYYY-MM-DD or null — the coverage/service START date",
  "end_date": "YYYY-MM-DD or null — the coverage/service END date",
  "expense_category": "string or null — the expense this should amortize into (e.g. 'Insurance expense', 'Software', 'Rent')",
  "snippet": "string or null — a short VERBATIM excerpt naming the amount and the coverage period",
  "confidence": { "total": 0-1, "term": 0-1, "dates": 0-1, "vendor": 0-1 },
  "document_note": "string or null — anything unusual (scanned/illegible, not clearly a prepaid, multiple items)"
}

Rules:
- The AMOUNT is in whole dollars. If a period is given as a date range but no month count, still fill start_date and end_date; the term will be derived.
- If a field is not stated, use null and set its confidence to 0. NEVER invent a value.
- If this does not look like a prepaid expense, say so in document_note and leave the amount null.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded prepaid document into a proposed schedule THROUGH the Core AI
 * gateway (metered, budget-capped per tenant). Accepts base64 PDF or image. Never
 * throws for expected failures — returns `{ ok: false, ... }` so callers degrade.
 */
export async function parsePrepaidDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParsePrepaidResult> {
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
        feature: PREPAID_EXTRACT_FEATURE,
        model: PREPAID_EXTRACT_MODEL,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: EXTRACTION_PROMPT }] }],
        max_tokens: 1500,
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
    console.error('[prepaid-extract] failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const prepaid = normalizePrepaidExtraction(parsed);
  const documentNote =
    parsed && typeof parsed === 'object' ? toStringOrNull((parsed as { document_note?: unknown }).document_note) : null;

  return {
    ok: true,
    prepaid,
    model: gw.model_used ?? PREPAID_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
