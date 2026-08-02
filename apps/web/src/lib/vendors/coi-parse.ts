/**
 * Certificate of Insurance (COI) parser — DROP-AND-PARSE vendor-insurance extraction.
 *
 * Takes an uploaded ACORD-style Certificate of Insurance (PDF or image → base64) and,
 * THROUGH the Core AI gateway (`@meritbooks/core-ai`, feature COI_EXTRACT, metered to
 * core.ai_usage_log, tenant budget enforced across the combined suite), extracts the
 * STRUCTURED coverage facts a COI carries: carrier, policy number, coverage types with
 * limits, effective + EXPIRATION dates, and the additional-insured flag.
 *
 * Canon boundary (§2/§3): the AI PROPOSES facts — it never writes the compliance
 * record. The model returns JSON validated by normalization here; the human reviews /
 * edits / confirms, and only confirmed coverages persist via the gated confirm path.
 * Anything undeterminable is left BLANK for the human — never guessed. Limits are
 * integers (cents).
 *
 * OWNERSHIP (reported, not written): `vendor_compliance_docs` (migration 005) stores
 * only doc_type (W9|GL_COI|WC_COI|WC_EXEMPTION), status, issued_date, expiration_date,
 * and coverage_amount_cents. It has NO column for carrier, policy number,
 * additional-insured, aggregate-vs-each-occurrence, or non-GL/WC coverage lines (auto,
 * umbrella, professional). So the confirm persists ONLY the GL and WC lines with their
 * limit + expiration; the richer structured detail is surfaced to the human and kept in
 * the ai_decisions audit row, and the schema gap is reported (no migration this wave).
 *
 * The model call lives in `parseCoiDocument`; the pure, deterministic
 * `normalizeCoiExtraction` (coverage mapping + date/limit parsing + blank-on-unknown)
 * is exported separately and unit-tested with no gateway dependency.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';

export const COI_EXTRACT_FEATURE = 'COI_EXTRACT';
export const COI_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

/** Coverage lines a COI can carry, normalized to a constrained enum. */
export const COVERAGE_TYPE_VALUES = [
  'GENERAL_LIABILITY',
  'WORKERS_COMP',
  'AUTO',
  'UMBRELLA',
  'PROFESSIONAL',
  'POLLUTION',
  'OTHER',
] as const;
export type CoverageType = (typeof COVERAGE_TYPE_VALUES)[number];

/** The Books compliance doc types a coverage line can persist to (else null → reported). */
export type ComplianceDocType = 'GL_COI' | 'WC_COI';

/** Map a coverage type onto a `vendor_compliance_docs.doc_type`, or null if unmappable. */
export function coverageToDocType(type: CoverageType): ComplianceDocType | null {
  if (type === 'GENERAL_LIABILITY') return 'GL_COI';
  if (type === 'WORKERS_COMP') return 'WC_COI';
  return null; // AUTO / UMBRELLA / PROFESSIONAL / POLLUTION / OTHER have no doc_type column
}

/** One proposed coverage line off the certificate. Limits are integer cents. */
export interface ProposedCoverage {
  coverage_type: CoverageType;
  /** Books doc_type this maps to (GL_COI/WC_COI) or null when it cannot be persisted. */
  doc_type: ComplianceDocType | null;
  /** Each-occurrence / per-claim limit, in cents. Null when not stated. */
  each_occurrence_cents: number | null;
  /** Aggregate limit, in cents. Null when not stated. */
  aggregate_cents: number | null;
  effective_date: string | null;
  expiration_date: string | null;
  confidence: Record<string, number>;
  lowConfidenceFields: string[];
}

/** The full proposed COI: certificate-level facts + the coverage lines. */
export interface ProposedCoi {
  carrier: string | null;
  policy_number: string | null;
  named_insured: string | null;
  certificate_holder: string | null;
  additional_insured: boolean | null;
  coverages: ProposedCoverage[];
}

export type ParseCoiResult =
  | {
      ok: true;
      coi: ProposedCoi;
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

const LOW_CONFIDENCE = 0.6;

/** Map free-form coverage language onto the constrained enum. Unknown => OTHER. */
export function mapCoverageType(raw: unknown): CoverageType {
  if (typeof raw !== 'string') return 'OTHER';
  const s = raw.trim().toUpperCase();
  if (!s) return 'OTHER';

  if ((COVERAGE_TYPE_VALUES as readonly string[]).includes(s)) return s as CoverageType;

  const t = s.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const has = (...needles: string[]) => needles.some((n) => t.includes(n));

  // Order matters: specific lines before the broad "liability" catch.
  if (has('WORKERS COMP', 'WORKERS COMPENSATION', 'WORKMANS COMP', 'EMPLOYERS LIABILITY', 'WC'))
    return 'WORKERS_COMP';
  if (has('UMBRELLA', 'EXCESS LIAB', 'EXCESS LIABILITY')) return 'UMBRELLA';
  if (has('AUTO', 'AUTOMOBILE', 'VEHICLE')) return 'AUTO';
  if (has('PROFESSIONAL', 'ERRORS AND OMISSIONS', 'ERRORS OMISSIONS', 'MALPRACTICE')) return 'PROFESSIONAL';
  if (has('POLLUTION', 'ENVIRONMENTAL')) return 'POLLUTION';
  if (has('GENERAL LIABILITY', 'COMMERCIAL GENERAL', 'CGL', 'GENERAL LIAB', 'LIABILITY'))
    return 'GENERAL_LIABILITY';
  return 'OTHER';
}

/**
 * Parse a dollar limit into integer CENTS. Handles "$1,000,000", "1000000",
 * "1,000,000.00", and shorthand "$1M" / "2.5M" / "500K". Returns null when the
 * value is absent, non-numeric, or negative. Never returns a fractional cent.
 */
export function parseLimitToCents(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Math.round(raw * 100);
  }
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toUpperCase().replace(/\$/g, '').replace(/,/g, '').replace(/\s+/g, '');
  if (s === '') return null;

  let multiplier = 1;
  if (s.endsWith('M')) {
    multiplier = 1_000_000;
    s = s.slice(0, -1);
  } else if (s.endsWith('K')) {
    multiplier = 1_000;
    s = s.slice(0, -1);
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * multiplier * 100);
}

/** ISO yyyy-mm-dd or null. Rejects malformed shapes AND impossible calendar dates. */
export function toIsoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return s;
}

function toStringOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s === '' ? null : s;
}

function toBoolOrNull(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const s = raw.trim().toUpperCase();
    if (s === 'YES' || s === 'TRUE' || s === 'Y') return true;
    if (s === 'NO' || s === 'FALSE' || s === 'N') return false;
  }
  return null;
}

function conf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

interface RawCoverage {
  coverage_type?: unknown;
  raw_type_text?: unknown;
  each_occurrence?: unknown;
  aggregate?: unknown;
  effective_date?: unknown;
  expiration_date?: unknown;
  confidence?: unknown;
}

/**
 * Pure normalizer: turn the model's loose JSON into a validated ProposedCoi. Maps
 * each coverage type, parses limits to integer cents and dates to ISO, keeps
 * unknowns blank, and flags fields the human should scrutinize (blank/expired
 * expiration, low confidence). Never throws — a malformed shape yields an empty COI.
 */
export function normalizeCoiExtraction(raw: unknown, now: Date = new Date()): ProposedCoi {
  const root = (raw ?? {}) as {
    carrier?: unknown;
    policy_number?: unknown;
    named_insured?: unknown;
    certificate_holder?: unknown;
    additional_insured?: unknown;
    coverages?: unknown;
  };

  const list = Array.isArray(root.coverages) ? (root.coverages as RawCoverage[]) : [];
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const coverages: ProposedCoverage[] = [];
  for (const rc of list) {
    if (rc == null || typeof rc !== 'object') continue;

    const coverage_type = mapCoverageType(rc.coverage_type ?? rc.raw_type_text);
    const doc_type = coverageToDocType(coverage_type);
    const each_occurrence_cents = parseLimitToCents(rc.each_occurrence);
    const aggregate_cents = parseLimitToCents(rc.aggregate);
    const effective_date = toIsoDate(rc.effective_date);
    const expiration_date = toIsoDate(rc.expiration_date);

    const c = (rc.confidence ?? {}) as Record<string, unknown>;
    const confidence: Record<string, number> = {
      coverage_type: conf(c.coverage_type),
      each_occurrence: conf(c.each_occurrence),
      dates: conf(c.dates),
    };

    const low: string[] = [];
    if (coverage_type === 'OTHER') low.push('coverage_type');
    else if (confidence.coverage_type < LOW_CONFIDENCE) low.push('coverage_type');
    if (each_occurrence_cents === null && aggregate_cents === null) low.push('each_occurrence');
    if (!expiration_date) low.push('expiration_date');
    else if (new Date(expiration_date + 'T00:00:00Z') < today) low.push('expiration_date'); // already expired
    if (confidence.dates < LOW_CONFIDENCE && expiration_date) low.push('dates');

    coverages.push({
      coverage_type,
      doc_type,
      each_occurrence_cents,
      aggregate_cents,
      effective_date,
      expiration_date,
      confidence,
      lowConfidenceFields: Array.from(new Set(low)),
    });
  }

  return {
    carrier: toStringOrNull(root.carrier),
    policy_number: toStringOrNull(root.policy_number),
    named_insured: toStringOrNull(root.named_insured),
    certificate_holder: toStringOrNull(root.certificate_holder),
    additional_insured: toBoolOrNull(root.additional_insured),
    coverages,
  };
}

const EXTRACTION_PROMPT = `You are an expert risk / insurance analyst. Read this Certificate of Insurance (COI, usually an ACORD 25 form) and extract every coverage line it certifies.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "carrier": "string or null — the primary insurer / insurance company affording coverage",
  "policy_number": "string or null — the primary policy number (of the general-liability line if multiple)",
  "named_insured": "string or null — the INSURED (the vendor/contractor), not the certificate holder",
  "certificate_holder": "string or null — the CERTIFICATE HOLDER (who the COI was issued to)",
  "additional_insured": "true | false or null — whether the certificate holder is listed as an additional insured",
  "coverages": [
    {
      "coverage_type": "one of: GENERAL_LIABILITY | WORKERS_COMP | AUTO | UMBRELLA | PROFESSIONAL | POLLUTION | OTHER",
      "raw_type_text": "string — the coverage description exactly as written",
      "each_occurrence": "number or null — the each-occurrence / per-claim limit in WHOLE DOLLARS (1000000), NOT cents. For workers comp use the each-accident limit",
      "aggregate": "number or null — the general aggregate limit in WHOLE DOLLARS, null if not stated",
      "effective_date": "YYYY-MM-DD or null — policy effective date",
      "expiration_date": "YYYY-MM-DD or null — policy expiration date (critical — read carefully)",
      "confidence": {
        "coverage_type": number 0-1,
        "each_occurrence": number 0-1,
        "dates": number 0-1
      }
    }
  ],
  "document_note": "string or null — anything unusual (scanned/illegible, expired, not a COI, no coverages listed)"
}

Rules:
- Return EVERY coverage line the certificate shows (GL, auto, umbrella, workers comp, etc.).
- Limits in WHOLE DOLLARS as plain numbers. If a field is not stated, use null and set confidence 0. NEVER invent a value.
- The EXPIRATION date is the most important field — read it exactly as printed.
- If this is NOT a Certificate of Insurance, set carrier/coverages accordingly and explain in document_note.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded COI into a proposed compliance record THROUGH the Core AI
 * gateway (metered, budget-capped per tenant). Accepts base64 PDF or image data.
 * Never throws for the expected failure cases — returns `{ ok: false, ... }`.
 */
export async function parseCoiDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParseCoiResult> {
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
        feature: COI_EXTRACT_FEATURE,
        model: COI_EXTRACT_MODEL,
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
    console.error('[coi-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const coi = normalizeCoiExtraction(parsed);
  const documentNote =
    parsed && typeof parsed === 'object'
      ? toStringOrNull((parsed as { document_note?: unknown }).document_note)
      : null;

  return {
    ok: true,
    coi,
    model: gw.model_used ?? COI_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
