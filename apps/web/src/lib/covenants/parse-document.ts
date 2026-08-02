/**
 * Covenant document parser — DROP-AND-PARSE covenant extraction.
 *
 * Takes an uploaded credit agreement / loan document (PDF or image → base64) and,
 * THROUGH the Core AI gateway (`@meritbooks/core-ai`, feature COVENANT_EXTRACT,
 * metered to core.ai_usage_log, tenant budget enforced across the combined suite),
 * extracts a STRUCTURED list of proposed covenants mapped to the exact
 * `loan_covenants` fields (migration 078).
 *
 * Canon boundary (§2/§3): the AI PROPOSES facts — it never writes a covenant. The
 * model returns JSON that is validated by Zod and normalized here; the human
 * reviews/edits/confirms every proposal, and only the confirmed rows persist via the
 * EXISTING gated create path (`POST /api/covenants`). Anything the model can't
 * determine is left BLANK for the human — never guessed. A credit agreement usually
 * carries several covenants, so this returns ALL of them.
 *
 * The model call itself lives in `parseCovenantDocument`; the pure, deterministic
 * `normalizeExtraction` (enum mapping + direction inference + blank-on-unknown) is
 * exported separately and unit-tested with no gateway dependency.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';

export const COVENANT_EXTRACT_FEATURE = 'COVENANT_EXTRACT';
export const COVENANT_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

export const COVENANT_TYPE_VALUES = [
  'DSCR',
  'FCCR',
  'LEVERAGE',
  'CURRENT_RATIO',
  'MIN_LIQUIDITY',
  'TNW',
  'CUSTOM',
] as const;
export type CovenantType = (typeof COVENANT_TYPE_VALUES)[number];
export type Direction = 'MIN' | 'MAX';
export type Frequency = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type ThresholdUnit = 'RATIO' | 'CURRENCY';

/** Covenant types measured in currency (a dollar amount, not a ratio). */
const CURRENCY_TYPES: ReadonlySet<CovenantType> = new Set(['MIN_LIQUIDITY', 'TNW']);
/** Covenant types tested as a MAX (measured value must be <= threshold). */
const MAX_TYPES: ReadonlySet<CovenantType> = new Set(['LEVERAGE']);

/**
 * One proposed covenant, mapped onto the `loan_covenants` fields. Fields the model
 * could not determine are left blank (null) for the human to complete — never guessed.
 */
export interface ProposedCovenant {
  loan_name: string;
  facility: string | null;
  lender_name: string | null;
  covenant_type: CovenantType;
  /** Natural unit of `threshold`: a ratio (e.g. 1.25) or a dollar amount. */
  threshold_unit: ThresholdUnit;
  /** Null when not determinable from the document (human must supply before confirm). */
  threshold: number | null;
  direction: Direction;
  /** Null when the document did not state a test cadence (human picks; UI defaults QUARTERLY). */
  test_frequency: Frequency | null;
  /** Minimal measurement config the parser could infer; the rest is set in the editor. */
  measurement: { trailingMonths?: number };
  effective_date: string | null;
  maturity_date: string | null;
  /** Measurement note / clause reference the human can carry into `notes`. */
  notes: string | null;
  /** Verbatim excerpt of the covenant clause, for traceability. */
  snippet: string | null;
  /** Per-field model confidence, 0..1. Missing => 0. */
  confidence: Record<string, number>;
  /** Fields the UI should highlight for review (low confidence or blank-but-required). */
  lowConfidenceFields: string[];
}

export type ParseCovenantResult =
  | {
      ok: true;
      covenants: ProposedCovenant[];
      model: string;
      correlationId: string | null;
      extractionMs: number;
      /** Free-form note the model surfaced (e.g. "scanned, some clauses illegible"). */
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

/** Map free-form covenant language onto the constrained enum. Unknown => CUSTOM. */
export function mapCovenantType(raw: unknown): CovenantType {
  if (typeof raw !== 'string') return 'CUSTOM';
  const s = raw.trim().toUpperCase();
  if (!s) return 'CUSTOM';

  // Direct enum match first.
  if ((COVENANT_TYPE_VALUES as readonly string[]).includes(s)) return s as CovenantType;

  const t = s.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const has = (...needles: string[]) => needles.some((n) => t.includes(n));

  // Order matters: FCCR (fixed-charge) before DSCR (debt-service) since both mention "coverage".
  if (has('FCCR', 'FIXED CHARGE COVERAGE', 'FIXED CHARGE COVER')) return 'FCCR';
  if (has('DSCR', 'DEBT SERVICE COVERAGE', 'DEBT SERVICE COVER')) return 'DSCR';
  if (has('CURRENT RATIO')) return 'CURRENT_RATIO';
  if (
    has(
      'LEVERAGE',
      'NET DEBT TO EBITDA',
      'DEBT TO EBITDA',
      'DEBT EBITDA',
      'FUNDED DEBT',
      'TOTAL DEBT',
      'SENIOR DEBT',
    )
  )
    return 'LEVERAGE';
  if (has('TANGIBLE NET WORTH', 'TNW', 'NET WORTH')) return 'TNW';
  if (has('LIQUIDITY', 'MINIMUM CASH', 'MIN CASH', 'UNRESTRICTED CASH', 'AVAILABILITY'))
    return 'MIN_LIQUIDITY';

  return 'CUSTOM';
}

/**
 * Direction is inferred MECHANICALLY from the covenant type:
 *   - LEVERAGE (net-debt / debt-to-EBITDA) => MAX (measured value must be <= threshold)
 *   - DSCR / FCCR / CURRENT_RATIO / MIN_LIQUIDITY / TNW => MIN (value must be >= threshold)
 *   - CUSTOM => honor a valid model hint, else default MIN.
 */
export function inferDirection(type: CovenantType, hint?: unknown): Direction {
  if (MAX_TYPES.has(type)) return 'MAX';
  if (type === 'CUSTOM') {
    const h = typeof hint === 'string' ? hint.trim().toUpperCase() : '';
    if (h === 'MAX') return 'MAX';
    if (h === 'MIN') return 'MIN';
    return 'MIN';
  }
  return 'MIN';
}

export function unitForType(type: CovenantType, hint?: unknown): ThresholdUnit {
  if (CURRENCY_TYPES.has(type)) return 'CURRENCY';
  if (type === 'CUSTOM') {
    const h = typeof hint === 'string' ? hint.trim().toUpperCase() : '';
    if (h === 'CURRENCY' || h === 'DOLLARS' || h === 'USD') return 'CURRENCY';
  }
  return 'RATIO';
}

function toFrequency(raw: unknown): Frequency | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (s.startsWith('MONTH')) return 'MONTHLY';
  if (s.startsWith('QUART') || s.includes('QTR')) return 'QUARTERLY';
  if (s.startsWith('ANNUAL') || s.startsWith('YEAR') || s.includes('ANNUM')) return 'ANNUAL';
  return null;
}

/** ISO yyyy-mm-dd or null. Rejects malformed shapes AND impossible calendar dates. */
function toIsoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [, y, mo, d] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Round-trip through UTC to reject e.g. Feb 30 / Apr 31.
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return s;
}

function toNumberOrNull(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[$,\s]/g, '');
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
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

const LOW_CONFIDENCE = 0.6;

interface RawCovenant {
  covenant_type?: unknown;
  raw_type_text?: unknown;
  threshold?: unknown;
  threshold_unit?: unknown;
  direction?: unknown;
  test_frequency?: unknown;
  trailing_months?: unknown;
  loan_name?: unknown;
  facility?: unknown;
  lender_name?: unknown;
  effective_date?: unknown;
  maturity_date?: unknown;
  measurement_note?: unknown;
  snippet?: unknown;
  confidence?: unknown;
}

/**
 * Pure normalizer: turn the model's loose JSON into validated ProposedCovenants.
 * Enum-maps the type, mechanically infers direction, keeps thresholds/dates blank
 * when undeterminable, and flags low-confidence / blank-but-required fields. Never
 * throws — a malformed shape yields an empty list.
 */
export function normalizeExtraction(raw: unknown): ProposedCovenant[] {
  const root = (raw ?? {}) as {
    agreement?: { loan_name?: unknown; facility?: unknown; lender_name?: unknown };
    covenants?: unknown;
  };
  const agreement = root.agreement ?? {};
  const defLoan = toStringOrNull(agreement.loan_name);
  const defFacility = toStringOrNull(agreement.facility);
  const defLender = toStringOrNull(agreement.lender_name);

  const list = Array.isArray(root.covenants) ? (root.covenants as RawCovenant[]) : [];

  const out: ProposedCovenant[] = [];
  for (const rc of list) {
    if (rc == null || typeof rc !== 'object') continue;

    const typeSource = rc.covenant_type ?? rc.raw_type_text;
    const covenant_type = mapCovenantType(typeSource);
    const threshold_unit = unitForType(covenant_type, rc.threshold_unit);
    const direction = inferDirection(covenant_type, rc.direction);
    const threshold = toNumberOrNull(rc.threshold);
    const test_frequency = toFrequency(rc.test_frequency);

    const c = (rc.confidence ?? {}) as Record<string, unknown>;
    const confidence: Record<string, number> = {
      covenant_type: conf(c.covenant_type),
      threshold: conf(c.threshold),
      direction: conf(c.direction),
      test_frequency: conf(c.test_frequency),
      loan_name: conf(c.loan_name),
      dates: conf(c.dates),
    };

    const trailing = toNumberOrNull(rc.trailing_months);
    const measurement: { trailingMonths?: number } = {};
    if (trailing !== null && trailing >= 1 && trailing <= 60) {
      measurement.trailingMonths = Math.round(trailing);
    }

    const loan_name = toStringOrNull(rc.loan_name) ?? defLoan ?? '';
    const facility = toStringOrNull(rc.facility) ?? defFacility;
    const lender_name = toStringOrNull(rc.lender_name) ?? defLender;

    // Flag fields the human should scrutinize: blank-but-required, or low confidence.
    const low: string[] = [];
    if (threshold === null) low.push('threshold');
    else if (confidence.threshold < LOW_CONFIDENCE) low.push('threshold');
    if (covenant_type === 'CUSTOM') low.push('covenant_type');
    else if (confidence.covenant_type < LOW_CONFIDENCE) low.push('covenant_type');
    if (test_frequency === null) low.push('test_frequency');
    if (!loan_name) low.push('loan_name');
    else if (confidence.loan_name < LOW_CONFIDENCE) low.push('loan_name');

    out.push({
      loan_name,
      facility,
      lender_name,
      covenant_type,
      threshold_unit,
      threshold,
      direction,
      test_frequency,
      measurement,
      effective_date: toIsoDate(rc.effective_date),
      maturity_date: toIsoDate(rc.maturity_date),
      notes: toStringOrNull(rc.measurement_note),
      snippet: toStringOrNull(rc.snippet),
      confidence,
      lowConfidenceFields: Array.from(new Set(low)),
    });
  }

  return out;
}

const EXTRACTION_PROMPT = `You are an expert corporate credit analyst. Read this loan / credit agreement and extract EVERY financial covenant it defines.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "agreement": {
    "loan_name": "string or null — the facility/loan name (e.g. 'Term Loan A')",
    "facility": "string or null — facility description (e.g. '$25M Senior Secured Revolver')",
    "lender_name": "string or null — the lender/administrative agent"
  },
  "covenants": [
    {
      "covenant_type": "one of: DSCR | FCCR | LEVERAGE | CURRENT_RATIO | MIN_LIQUIDITY | TNW | CUSTOM",
      "raw_type_text": "string — the covenant name exactly as written in the agreement",
      "threshold": number or null — the required level as a plain number. For ratios use the decimal (1.25). For dollar covenants (min liquidity, tangible net worth) use whole DOLLARS (5000000), NOT cents. null if not stated,
      "threshold_unit": "ratio | currency",
      "direction": "MIN | MAX — MIN means measured value must be >= threshold; MAX means <= threshold. Coverage/current-ratio/liquidity/net-worth are MIN; leverage/debt-to-EBITDA is MAX",
      "test_frequency": "MONTHLY | QUARTERLY | ANNUAL or null if not stated",
      "trailing_months": number or null — measurement window if stated (e.g. 'trailing twelve months' = 12),
      "loan_name": "string or null — override if this covenant belongs to a specific facility",
      "facility": "string or null",
      "lender_name": "string or null",
      "effective_date": "YYYY-MM-DD or null — closing/effective date",
      "maturity_date": "YYYY-MM-DD or null",
      "measurement_note": "string or null — how it is measured + the section reference (e.g. 'Consolidated EBITDA / Fixed Charges; §7.1(a)')",
      "snippet": "string — a short VERBATIM excerpt of the covenant clause for traceability",
      "confidence": {
        "covenant_type": number 0-1,
        "threshold": number 0-1,
        "direction": number 0-1,
        "test_frequency": number 0-1,
        "loan_name": number 0-1,
        "dates": number 0-1
      }
    }
  ],
  "document_note": "string or null — anything unusual (scanned/illegible, draft, amendment, no covenants found)"
}

Rules:
- Return ALL financial covenants — a credit agreement usually has several.
- If a field is not stated in the document, use null and set its confidence to 0. NEVER invent a value.
- Ratios as decimals (1.25x => 1.25). Dollar covenants in WHOLE DOLLARS.
- If the document contains NO financial covenants, return "covenants": [] and explain in document_note.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded loan document into proposed covenants THROUGH the Core AI
 * gateway (metered, budget-capped per tenant; `orgId` scopes it, `userId`
 * attributes it). Accepts base64-encoded PDF or image data. Never throws for the
 * expected failure cases — returns `{ ok: false, ... }` so callers degrade cleanly.
 */
export async function parseCovenantDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParseCovenantResult> {
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
        feature: COVENANT_EXTRACT_FEATURE,
        model: COVENANT_EXTRACT_MODEL,
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
    console.error('[covenant-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const covenants = normalizeExtraction(parsed);
  const documentNote =
    parsed && typeof parsed === 'object'
      ? toStringOrNull((parsed as { document_note?: unknown }).document_note)
      : null;

  return {
    ok: true,
    covenants,
    model: gw.model_used ?? COVENANT_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
