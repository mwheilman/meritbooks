/**
 * Insurance policy parser — DROP-AND-PARSE extraction of the company's OWN policies.
 *
 * Takes an uploaded insurance policy / declarations page (PDF or image → base64) and,
 * THROUGH the Core AI gateway (`@meritbooks/core-ai`, feature INSURANCE_EXTRACT,
 * metered to core.ai_usage_log, tenant budget enforced across the combined suite),
 * extracts the STRUCTURED terms a policy carries: carrier, policy number, coverage
 * type + limit, deductible, premium + frequency, and the effective/expiration term.
 *
 * Canon boundary (§2/§3): the AI PROPOSES facts — it never writes the register. The
 * model returns JSON validated + normalized here; the human reviews / edits / confirms,
 * and only confirmed policies persist via the gated create path (`POST /api/insurance`,
 * RLS + Zod). Anything undeterminable is left BLANK for the human — never guessed.
 * Limits, deductibles, and premiums are integers (cents).
 *
 * This is DISTINCT from the vendor COI parser (`lib/vendors/coi-parse.ts`): a COI is a
 * VENDOR's insurance handed to us for compliance; this is the tenant's OWN book of
 * policies. The coverage taxonomy is the register's (GL/PROPERTY/AUTO/WC/CYBER/...),
 * not the COI's.
 *
 * The model call lives in `parsePolicyDocument`; the pure, deterministic normalizer
 * (`normalizePolicyExtraction` + `mapCoverageType` + `dollarsToCentsOrNull`) is
 * exported separately and unit-tested with no gateway dependency.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';

export const INSURANCE_EXTRACT_FEATURE = 'INSURANCE_EXTRACT';
export const INSURANCE_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

/** Coverage lines the tenant's own register recognizes, normalized to a constrained enum. */
export const COVERAGE_TYPE_VALUES = [
  'GL',
  'PROPERTY',
  'AUTO',
  'WC',
  'CYBER',
  'UMBRELLA',
  'PROFESSIONAL',
  'OTHER',
] as const;
export type CoverageType = (typeof COVERAGE_TYPE_VALUES)[number];

export const PREMIUM_FREQUENCY_VALUES = [
  'ANNUAL',
  'SEMIANNUAL',
  'QUARTERLY',
  'MONTHLY',
  'ONE_TIME',
] as const;
export type PremiumFrequency = (typeof PREMIUM_FREQUENCY_VALUES)[number];

const LOW_CONFIDENCE = 0.6;

/** One proposed policy, mapped onto the `insurance_policies` fields. Blank when unknown. */
export interface ProposedPolicy {
  carrier: string | null;
  policy_number: string | null;
  coverage_type: CoverageType;
  coverage_limit_cents: number | null;
  deductible_cents: number | null;
  premium_cents: number | null;
  premium_frequency: PremiumFrequency;
  effective_date: string | null;
  expiration_date: string | null;
  broker: string | null;
  notes: string | null;
  /** Verbatim excerpt (declarations line) for traceability. */
  snippet: string | null;
  confidence: Record<string, number>;
  /** Fields the UI should highlight for review (low confidence or blank-but-required). */
  lowConfidenceFields: string[];
}

export type ParsePolicyResult =
  | {
      ok: true;
      policies: ProposedPolicy[];
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

/** Map free-form coverage language onto the register's constrained enum. Unknown => OTHER. */
export function mapCoverageType(raw: unknown): CoverageType {
  if (typeof raw !== 'string') return 'OTHER';
  const s = raw.trim().toUpperCase();
  if (!s) return 'OTHER';

  // Direct enum match first.
  if ((COVERAGE_TYPE_VALUES as readonly string[]).includes(s)) return s as CoverageType;

  const t = s.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const has = (...needles: string[]) => needles.some((n) => t.includes(n));

  // Order matters: specific lines before the broad "liability" catch.
  if (has('WORKERS COMP', 'WORKERS COMPENSATION', 'WORKMANS COMP', 'EMPLOYERS LIABILITY', 'WC'))
    return 'WC';
  if (has('CYBER', 'DATA BREACH', 'PRIVACY LIAB', 'NETWORK SECURITY')) return 'CYBER';
  if (has('UMBRELLA', 'EXCESS LIAB', 'EXCESS LIABILITY')) return 'UMBRELLA';
  if (has('AUTO', 'AUTOMOBILE', 'VEHICLE', 'FLEET', 'MOTOR')) return 'AUTO';
  if (has('PROFESSIONAL', 'ERRORS AND OMISSIONS', 'ERRORS OMISSIONS', 'MALPRACTICE', 'E O', 'D O', 'DIRECTORS AND OFFICERS'))
    return 'PROFESSIONAL';
  if (has('PROPERTY', 'BUILDING', 'CONTENTS', 'INLAND MARINE', 'BUSINESS PERSONAL PROPERTY', 'FIRE'))
    return 'PROPERTY';
  if (has('GENERAL LIABILITY', 'COMMERCIAL GENERAL', 'CGL', 'GENERAL LIAB', 'LIABILITY')) return 'GL';
  return 'OTHER';
}

/** Normalize a premium cadence onto the constrained enum. Unknown => ANNUAL (typical). */
export function mapPremiumFrequency(raw: unknown): PremiumFrequency {
  if (typeof raw !== 'string') return 'ANNUAL';
  const s = raw.trim().toUpperCase();
  if (!s) return 'ANNUAL';
  if ((PREMIUM_FREQUENCY_VALUES as readonly string[]).includes(s)) return s as PremiumFrequency;
  if (s.startsWith('MONTH')) return 'MONTHLY';
  if (s.startsWith('QUART') || s.includes('QTR')) return 'QUARTERLY';
  if (s.startsWith('SEMI') || s.includes('BIANNUAL') || s.includes('BI-ANNUAL') || s.includes('TWICE'))
    return 'SEMIANNUAL';
  if (s.includes('ONE TIME') || s.includes('ONE-TIME') || s.includes('SINGLE') || s.includes('LUMP'))
    return 'ONE_TIME';
  if (s.startsWith('ANNUAL') || s.startsWith('YEAR') || s.includes('ANNUM') || s === 'PA') return 'ANNUAL';
  return 'ANNUAL';
}

/**
 * Parse a dollar amount into integer CENTS. Handles "$1,000,000", "1000000",
 * "1,000,000.00", and shorthand "$1M" / "2.5M" / "500K". Returns null when the
 * value is missing, non-positive, or unparseable — never guesses.
 */
export function dollarsToCentsOrNull(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.round(raw * 100);
  }
  if (typeof raw !== 'string') return null;

  let s = raw.trim().toUpperCase().replace(/[$,\s]/g, '');
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
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * multiplier * 100);
}

/** ISO yyyy-mm-dd or null. Rejects malformed shapes AND impossible calendar dates. */
export function toIsoDateOrNull(raw: unknown): string | null {
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

function conf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

interface RawPolicy {
  carrier?: unknown;
  policy_number?: unknown;
  coverage_type?: unknown;
  raw_type_text?: unknown;
  coverage_limit?: unknown;
  deductible?: unknown;
  premium?: unknown;
  premium_frequency?: unknown;
  effective_date?: unknown;
  expiration_date?: unknown;
  broker?: unknown;
  notes?: unknown;
  snippet?: unknown;
  confidence?: unknown;
}

/**
 * Pure normalizer: turn the model's loose JSON into validated ProposedPolicies.
 * Enum-maps coverage + frequency, keeps amounts/dates blank when undeterminable, and
 * flags low-confidence / blank-but-required fields. Never throws — a malformed shape
 * yields an empty list.
 */
export function normalizePolicyExtraction(raw: unknown): ProposedPolicy[] {
  const root = (raw ?? {}) as { policies?: unknown; policy?: unknown };
  // Accept either a `policies` array or a single `policy` object (declarations page).
  const list: RawPolicy[] = Array.isArray(root.policies)
    ? (root.policies as RawPolicy[])
    : root.policy && typeof root.policy === 'object'
      ? [root.policy as RawPolicy]
      : [];

  const out: ProposedPolicy[] = [];
  for (const rp of list) {
    if (rp == null || typeof rp !== 'object') continue;

    const coverage_type = mapCoverageType(rp.coverage_type ?? rp.raw_type_text);
    const premium_frequency = mapPremiumFrequency(rp.premium_frequency);
    const coverage_limit_cents = dollarsToCentsOrNull(rp.coverage_limit);
    const deductible_cents = dollarsToCentsOrNull(rp.deductible);
    const premium_cents = dollarsToCentsOrNull(rp.premium);
    const carrier = toStringOrNull(rp.carrier);
    const policy_number = toStringOrNull(rp.policy_number);
    const effective_date = toIsoDateOrNull(rp.effective_date);
    const expiration_date = toIsoDateOrNull(rp.expiration_date);

    const c = (rp.confidence ?? {}) as Record<string, unknown>;
    const confidence: Record<string, number> = {
      carrier: conf(c.carrier),
      coverage_type: conf(c.coverage_type),
      coverage_limit: conf(c.coverage_limit),
      premium: conf(c.premium),
      dates: conf(c.dates),
    };

    // Flag fields the human should scrutinize: blank-but-required, or low confidence.
    const low: string[] = [];
    if (!carrier) low.push('carrier');
    else if (confidence.carrier < LOW_CONFIDENCE) low.push('carrier');
    if (coverage_type === 'OTHER') low.push('coverage_type');
    else if (confidence.coverage_type < LOW_CONFIDENCE) low.push('coverage_type');
    if (coverage_limit_cents === null) low.push('coverage_limit');
    else if (confidence.coverage_limit < LOW_CONFIDENCE) low.push('coverage_limit');
    if (premium_cents === null) low.push('premium');
    if (expiration_date === null) low.push('expiration_date');

    out.push({
      carrier,
      policy_number,
      coverage_type,
      coverage_limit_cents,
      deductible_cents,
      premium_cents,
      premium_frequency,
      effective_date,
      expiration_date,
      broker: toStringOrNull(rp.broker),
      notes: toStringOrNull(rp.notes),
      snippet: toStringOrNull(rp.snippet),
      confidence,
      lowConfidenceFields: Array.from(new Set(low)),
    });
  }

  return out;
}

const EXTRACTION_PROMPT = `You are an expert commercial insurance analyst. Read this insurance policy / declarations page (it belongs to the company itself — its OWN coverage, NOT a vendor certificate) and extract EVERY distinct policy it defines.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "policies": [
    {
      "carrier": "string or null — the issuing insurer (e.g. 'The Hartford')",
      "policy_number": "string or null",
      "coverage_type": "one of: GL | PROPERTY | AUTO | WC | CYBER | UMBRELLA | PROFESSIONAL | OTHER",
      "raw_type_text": "string — the coverage name exactly as written",
      "coverage_limit": number or null — the per-occurrence or aggregate limit in WHOLE DOLLARS (1000000), NOT cents. null if not stated,
      "deductible": number or null — deductible / retention in WHOLE DOLLARS. null if not stated,
      "premium": number or null — the premium in WHOLE DOLLARS for the stated frequency. null if not stated,
      "premium_frequency": "ANNUAL | SEMIANNUAL | QUARTERLY | MONTHLY | ONE_TIME or null — how often the premium is billed",
      "effective_date": "YYYY-MM-DD or null — policy inception",
      "expiration_date": "YYYY-MM-DD or null — policy expiration / renewal date",
      "broker": "string or null — the broker / agency",
      "notes": "string or null — anything notable (endorsements, named insureds, sublimits)",
      "snippet": "string — a short VERBATIM excerpt of the declarations line for traceability",
      "confidence": {
        "carrier": number 0-1,
        "coverage_type": number 0-1,
        "coverage_limit": number 0-1,
        "premium": number 0-1,
        "dates": number 0-1
      }
    }
  ],
  "document_note": "string or null — anything unusual (scanned/illegible, quote not a bound policy, multiple policies on one dec page)"
}

Rules:
- Return ALL policies — a declarations package often lists several lines (GL, property, auto, umbrella).
- If a field is not stated in the document, use null and set its confidence to 0. NEVER invent a value.
- Amounts in WHOLE DOLLARS (a $1,000,000 limit => 1000000). Never cents.
- If the document contains NO insurance policy, return "policies": [] and explain in document_note.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded policy document into proposed policies THROUGH the Core AI
 * gateway (metered, budget-capped per tenant; `orgId` scopes it, `userId` attributes
 * it). Accepts base64-encoded PDF or image data. Never throws for the expected
 * failure cases — returns `{ ok: false, ... }` so callers degrade cleanly.
 */
export async function parsePolicyDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParsePolicyResult> {
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
        feature: INSURANCE_EXTRACT_FEATURE,
        model: INSURANCE_EXTRACT_MODEL,
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
    console.error('[insurance-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const policies = normalizePolicyExtraction(parsed);
  const documentNote =
    parsed && typeof parsed === 'object'
      ? toStringOrNull((parsed as { document_note?: unknown }).document_note)
      : null;

  return {
    ok: true,
    policies,
    model: gw.model_used ?? INSURANCE_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
