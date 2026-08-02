/**
 * W-9 document parser — DROP-AND-PARSE vendor tax-identity extraction.
 *
 * Takes an uploaded IRS Form W-9 (PDF or image → base64) and, THROUGH the Core AI
 * gateway (`@meritbooks/core-ai`, feature W9_EXTRACT, metered to core.ai_usage_log,
 * tenant budget enforced across the combined suite), extracts the STRUCTURED tax
 * facts a W-9 carries: legal name, business/DBA name, TIN/EIN, federal tax
 * classification, address, and a 1099-eligibility signal.
 *
 * Canon boundary (§2/§3): the AI PROPOSES facts — it never writes the vendor. The
 * model returns JSON validated by Zod-style normalization here; the human reviews /
 * edits / confirms, and only confirmed fields persist via the gated confirm path
 * (which writes only the columns Books OWNS on `core.vendors` per the ownership
 * matrix). Anything undeterminable is left BLANK for the human — never guessed.
 *
 * PRIVACY: the raw TIN NEVER leaves this module. `normalizeW9Extraction` masks it
 * (last four only) before it lands in the proposal or the ai_decisions audit row.
 * The plaintext SSN/EIN is discarded — it is not persisted anywhere by Books.
 *
 * OWNERSHIP (reported, not written): `core.vendors` has only `tin_encrypted` (no
 * Books-side encryption path) and NO federal-tax-classification / exempt-code
 * column. So the confirm writes legal name, business name, address, is_1099_eligible,
 * and flips `w9_status` to RECEIVED (feeds 1099 readiness) — the TIN and entity type
 * are surfaced for the human but persistence is a Core follow-up (see route note).
 *
 * The model call lives in `parseW9Document`; the pure, deterministic
 * `normalizeW9Extraction` (classification mapping + TIN masking + eligibility
 * inference + blank-on-unknown) is exported separately and unit-tested with no
 * gateway dependency.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';

export const W9_EXTRACT_FEATURE = 'W9_EXTRACT';
export const W9_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

/** Federal tax classification (Form W-9 line 3), normalized to a constrained enum. */
export const W9_ENTITY_TYPE_VALUES = [
  'INDIVIDUAL_SOLE_PROP',
  'C_CORP',
  'S_CORP',
  'PARTNERSHIP',
  'TRUST_ESTATE',
  'LLC',
  'OTHER',
] as const;
export type W9EntityType = (typeof W9_ENTITY_TYPE_VALUES)[number];

/** For an LLC, the tax treatment it elected (Form W-9 line 3 "C/S/P"). */
export type LlcTaxClass = 'C' | 'S' | 'P' | null;
export type TinType = 'EIN' | 'SSN' | null;

/** One proposed vendor tax identity, mapped onto the fields Books can act on. */
export interface ProposedW9 {
  /** Legal name (W-9 line 1) → core.vendors.name. */
  legal_name: string | null;
  /** Business / DBA name (W-9 line 2) → core.vendors.display_name. */
  business_name: string | null;
  entity_type: W9EntityType;
  llc_tax_class: LlcTaxClass;
  /** MASKED TIN (last four only) for display. The raw value is never retained. */
  tin_masked: string | null;
  tin_type: TinType;
  /** Last four digits, for the human to confirm against their records. */
  tin_last4: string | null;
  exempt_payee_code: string | null;
  fatca_code: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /**
   * Proposed 1099-NEC eligibility inferred MECHANICALLY from the classification
   * (corporations are generally exempt; individuals/partnerships/LLC-P are not).
   * Null when the classification doesn't determine it — the human decides.
   */
  is_1099_eligible_signal: boolean | null;
  /** Per-field model confidence, 0..1. Missing => 0. */
  confidence: Record<string, number>;
  /** Fields the UI should highlight (low confidence or blank-but-important). */
  lowConfidenceFields: string[];
}

export type ParseW9Result =
  | {
      ok: true;
      proposal: ProposedW9;
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

const LOW_CONFIDENCE = 0.6;

/** Corporations (incl. LLCs taxed as a corporation) are generally 1099-exempt. */
const CORP_TYPES: ReadonlySet<W9EntityType> = new Set(['C_CORP', 'S_CORP']);

/** Map free-form W-9 line-3 language onto the constrained classification enum. */
export function mapEntityType(raw: unknown): W9EntityType {
  if (typeof raw !== 'string') return 'OTHER';
  const s = raw.trim().toUpperCase();
  if (!s) return 'OTHER';

  if ((W9_ENTITY_TYPE_VALUES as readonly string[]).includes(s)) return s as W9EntityType;

  const t = s.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const has = (...needles: string[]) => needles.some((n) => t.includes(n));

  // The W-9 line-3 checkbox groups "Individual/sole proprietor or single-member
  // LLC" — a single-member LLC is a disregarded entity treated as an individual,
  // so the individual signals must win even though the text contains "LLC".
  if (has('INDIVIDUAL', 'SOLE PROP', 'SOLE PROPRIETOR', 'SINGLE MEMBER', 'DISREGARDED'))
    return 'INDIVIDUAL_SOLE_PROP';
  // LLC must be checked before the bare CORP/PARTNERSHIP words so "LLC taxed as
  // C corp" still classifies as an LLC (its treatment is carried in llc_tax_class).
  if (has('LLC', 'LIMITED LIABILITY')) return 'LLC';
  if (has('S CORP', 'S CORPORATION', 'SUBCHAPTER S')) return 'S_CORP';
  if (has('C CORP', 'C CORPORATION', 'CORPORATION', 'INC', 'CORP')) return 'C_CORP';
  if (has('PARTNERSHIP', 'LLP', 'GENERAL PARTNER', 'LIMITED PARTNER')) return 'PARTNERSHIP';
  if (has('TRUST', 'ESTATE')) return 'TRUST_ESTATE';
  return 'OTHER';
}

/** Normalize the LLC tax-class letter (C/S/P) or null. */
export function mapLlcTaxClass(raw: unknown): LlcTaxClass {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (s === 'C' || s.includes('C CORP')) return 'C';
  if (s === 'S' || s.includes('S CORP')) return 'S';
  if (s === 'P' || s.includes('PARTNER')) return 'P';
  return null;
}

/**
 * Infer 1099-NEC eligibility from the classification:
 *   - INDIVIDUAL_SOLE_PROP / PARTNERSHIP => true (reportable)
 *   - C_CORP / S_CORP => false (generally exempt)
 *   - LLC => depends on its elected tax class: C/S => false, P => true, unknown => null
 *   - TRUST_ESTATE / OTHER => null (a human must decide)
 */
export function infer1099Eligibility(type: W9EntityType, llc: LlcTaxClass): boolean | null {
  if (type === 'INDIVIDUAL_SOLE_PROP' || type === 'PARTNERSHIP') return true;
  if (CORP_TYPES.has(type)) return false;
  if (type === 'LLC') {
    if (llc === 'C' || llc === 'S') return false;
    if (llc === 'P') return true;
    return null; // LLC with no stated tax class — ambiguous, human decides
  }
  return null;
}

/**
 * Mask a TIN to its last four digits, preserving a readable EIN/SSN shape. Returns
 * null when fewer than four digits are present (nothing safe to show). The raw
 * value is intentionally NOT returned — only the mask + last four escape.
 */
export function maskTin(raw: unknown, tinType: TinType): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 4) return null;
  const last4 = digits.slice(-4);
  if (tinType === 'SSN') return `XXX-XX-${last4}`;
  if (tinType === 'EIN') return `XX-XXX${last4}`;
  return `${'X'.repeat(Math.max(0, digits.length - 4))}${last4}`;
}

/** Last four digits of a TIN, or null. */
export function tinLast4(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** Infer EIN vs SSN from a hint or the raw formatting (EIN is XX-XXXXXXX). */
export function inferTinType(hint: unknown, raw: unknown): TinType {
  if (typeof hint === 'string') {
    const h = hint.trim().toUpperCase();
    if (h === 'EIN') return 'EIN';
    if (h === 'SSN') return 'SSN';
  }
  if (typeof raw === 'string') {
    if (/^\d{2}-\d{7}$/.test(raw.trim())) return 'EIN';
    if (/^\d{3}-\d{2}-\d{4}$/.test(raw.trim())) return 'SSN';
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

interface RawW9 {
  legal_name?: unknown;
  business_name?: unknown;
  entity_type?: unknown;
  federal_tax_classification?: unknown;
  llc_tax_class?: unknown;
  tin?: unknown;
  tin_type?: unknown;
  exempt_payee_code?: unknown;
  fatca_code?: unknown;
  address_line1?: unknown;
  address_line2?: unknown;
  city?: unknown;
  state?: unknown;
  zip?: unknown;
  is_1099_eligible?: unknown;
  confidence?: unknown;
}

/**
 * Pure normalizer: turn the model's loose JSON into a validated ProposedW9.
 * Maps the classification, masks the TIN (discarding the raw value), mechanically
 * infers eligibility, keeps unknowns blank, and flags fields for human review.
 * Never throws — a malformed shape yields a blank-but-valid proposal.
 */
export function normalizeW9Extraction(raw: unknown): ProposedW9 {
  const r = (raw ?? {}) as RawW9;

  const entity_type = mapEntityType(r.entity_type ?? r.federal_tax_classification);
  const llc_tax_class = entity_type === 'LLC' ? mapLlcTaxClass(r.llc_tax_class) : null;
  const tin_type = inferTinType(r.tin_type, r.tin);
  const tin_masked = maskTin(r.tin, tin_type);
  const tin_last4 = tinLast4(r.tin);
  const is_1099_eligible_signal = infer1099Eligibility(entity_type, llc_tax_class);

  const c = (r.confidence ?? {}) as Record<string, unknown>;
  const confidence: Record<string, number> = {
    legal_name: conf(c.legal_name),
    business_name: conf(c.business_name),
    entity_type: conf(c.entity_type),
    tin: conf(c.tin),
    address: conf(c.address),
    is_1099_eligible: conf(c.is_1099_eligible),
  };

  const legal_name = toStringOrNull(r.legal_name);

  const low: string[] = [];
  if (!legal_name) low.push('legal_name');
  else if (confidence.legal_name < LOW_CONFIDENCE) low.push('legal_name');
  if (entity_type === 'OTHER') low.push('entity_type');
  else if (confidence.entity_type < LOW_CONFIDENCE) low.push('entity_type');
  if (!tin_last4) low.push('tin');
  else if (confidence.tin < LOW_CONFIDENCE) low.push('tin');
  if (is_1099_eligible_signal === null) low.push('is_1099_eligible');

  return {
    legal_name,
    business_name: toStringOrNull(r.business_name),
    entity_type,
    llc_tax_class,
    tin_masked,
    tin_type,
    tin_last4,
    exempt_payee_code: toStringOrNull(r.exempt_payee_code),
    fatca_code: toStringOrNull(r.fatca_code),
    address_line1: toStringOrNull(r.address_line1),
    address_line2: toStringOrNull(r.address_line2),
    city: toStringOrNull(r.city),
    state: toStringOrNull(r.state),
    zip: toStringOrNull(r.zip),
    is_1099_eligible_signal,
    confidence,
    lowConfidenceFields: Array.from(new Set(low)),
  };
}

const EXTRACTION_PROMPT = `You are an expert accounts-payable analyst. Read this IRS Form W-9 (Request for Taxpayer Identification Number and Certification) and extract the taxpayer's identity.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "legal_name": "string or null — Line 1, the name as shown on the income tax return",
  "business_name": "string or null — Line 2, business name / disregarded entity / DBA if different from Line 1",
  "entity_type": "one of: INDIVIDUAL_SOLE_PROP | C_CORP | S_CORP | PARTNERSHIP | TRUST_ESTATE | LLC | OTHER — Line 3 federal tax classification",
  "llc_tax_class": "C | S | P or null — ONLY if entity_type is LLC, the tax classification letter on Line 3",
  "tin": "string or null — the Taxpayer Identification Number exactly as written (SSN xxx-xx-xxxx or EIN xx-xxxxxxx). Part I",
  "tin_type": "EIN | SSN or null — which box the TIN was entered in",
  "exempt_payee_code": "string or null — exempt payee code if present",
  "fatca_code": "string or null — FATCA exemption code if present",
  "address_line1": "string or null — Line 5 address",
  "address_line2": "string or null",
  "city": "string or null — Line 6",
  "state": "string or null — two-letter state",
  "zip": "string or null — Line 6 ZIP",
  "confidence": {
    "legal_name": number 0-1,
    "business_name": number 0-1,
    "entity_type": number 0-1,
    "tin": number 0-1,
    "address": number 0-1,
    "is_1099_eligible": number 0-1
  },
  "document_note": "string or null — anything unusual (scanned/illegible, unsigned, not actually a W-9, W-8 instead)"
}

Rules:
- If a field is not present or not legible, use null and set its confidence to 0. NEVER invent a value.
- Read the TIN exactly as printed — do not reformat or guess missing digits.
- If this is NOT a Form W-9 (e.g. a W-8, a COI, an invoice), set every field to null and explain in document_note.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded W-9 into a proposed vendor tax identity THROUGH the Core AI
 * gateway (metered, budget-capped per tenant). Accepts base64 PDF or image data.
 * Never throws for the expected failure cases — returns `{ ok: false, ... }`.
 */
export async function parseW9Document(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParseW9Result> {
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
        feature: W9_EXTRACT_FEATURE,
        model: W9_EXTRACT_MODEL,
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
    console.error('[w9-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const proposal = normalizeW9Extraction(parsed);
  const documentNote =
    parsed && typeof parsed === 'object'
      ? toStringOrNull((parsed as { document_note?: unknown }).document_note)
      : null;

  return {
    ok: true,
    proposal,
    model: gw.model_used ?? W9_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
