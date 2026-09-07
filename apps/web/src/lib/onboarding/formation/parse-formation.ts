/**
 * Formation-document parser — DROP-AND-PARSE legal-record extraction.
 *
 * Takes an uploaded FORMATION document (EIN letter / SS-4 confirmation, articles of
 * organization or incorporation, certificate of formation, or operating agreement —
 * PDF or image → base64) and, THROUGH the Core AI gateway (`@meritbooks/core-ai`,
 * feature FORMATION_EXTRACT, metered to core.ai_usage_log, tenant budget enforced
 * across the combined suite), extracts the STRUCTURED legal record of ONE company
 * mapped to the `core.company_legal_records` fields (migration 151): legal name,
 * entity type, EIN, formation state + date, registered agent, and the members /
 * managers with their roles and ownership %.
 *
 * Canon boundary (§2/§3): the AI PROPOSES facts — it never writes the legal record.
 * The model returns JSON validated by the pure `normalizeFormation` (enum mapping +
 * blank-on-unknown + confidence flags); a human reviews/edits/confirms in the UI, and
 * only the confirmed record persists via the gated confirm path (`POST
 * /api/onboarding/formation`). Anything the model can't determine is left BLANK for
 * the human — never guessed.
 *
 * `parseFormationDocument` makes the model call; the pure `normalizeFormation`
 * (enum mapping + null-on-unknown + ownership clamp + confidence flags) is exported
 * separately and unit-tested with no gateway dependency.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';

export const FORMATION_EXTRACT_FEATURE = 'FORMATION_EXTRACT';
export const FORMATION_EXTRACT_MODEL = 'claude-sonnet-4-6';

/** The legal entity forms the table (and the product) recognizes. */
export type EntityType =
  | 'LLC'
  | 'C_CORP'
  | 'S_CORP'
  | 'PARTNERSHIP'
  | 'SOLE_PROP'
  | 'NONPROFIT'
  | 'OTHER';

export const ENTITY_TYPES: readonly EntityType[] = [
  'LLC',
  'C_CORP',
  'S_CORP',
  'PARTNERSHIP',
  'SOLE_PROP',
  'NONPROFIT',
  'OTHER',
];

/** A member / manager / owner named on the formation document. */
export interface ProposedMember {
  name: string;
  /** Free-text role as stated (e.g. "Managing Member", "President", "Director"). */
  role: string | null;
  /** Ownership as a PERCENT, clamped 0–100. Null when the document doesn't state it. */
  ownership_pct: number | null;
}

/**
 * A proposed legal record mapped onto `core.company_legal_records`. Fields the model
 * could not determine are null (never invented) for the human to complete/confirm.
 */
export interface ProposedFormation {
  legal_name: string;
  /** null when the entity form can't be determined (human picks it). */
  entity_type: EntityType | null;
  /** Employer Identification Number, normalized to NN-NNNNNNN when 9 digits are found. */
  ein: string | null;
  /** Two-letter USPS state code (or the raw state name if not resolvable to a code). */
  formation_state: string | null;
  /** Formation / incorporation date as YYYY-MM-DD. Null if not stated. */
  formation_date: string | null;
  registered_agent: string | null;
  members: ProposedMember[];
  /** Anything material the human should see (amendment, foreign registration, etc.). */
  document_note: string | null;
  /** A short VERBATIM excerpt anchoring the extraction, for traceability. */
  snippet: string | null;
  confidence: Record<string, number>;
  lowConfidenceFields: string[];
}

export type ParseFormationResult =
  | {
      ok: true;
      formation: ProposedFormation;
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

const LOW_CONFIDENCE = 0.6;

/* -------------------------------------------------------------------------- */
/* Field coercers                                                             */
/* -------------------------------------------------------------------------- */

function toStringOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s === '' ? null : s;
}

function toNumberOrNull(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[$,%\s]/g, '');
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Clamp a proposed ownership percent into 0–100, or null when undeterminable. */
function clampPct(raw: unknown): number | null {
  const n = toNumberOrNull(raw);
  if (n === null) return null;
  return Math.min(100, Math.max(0, n));
}

function toIsoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return s;
}

function conf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/* -------------------------------------------------------------------------- */
/* Enum / value mappers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Map a loose entity-form string to the canonical EntityType, or null when it
 * genuinely can't be determined (so the human picks it — never guessed).
 * Order matters: the more specific / distinguishing forms are tested first.
 */
export function mapEntityType(raw: unknown): EntityType | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (s === '') return null;

  // Already-canonical values pass straight through.
  const canon = s.replace(/[\s-]+/g, '_');
  if ((ENTITY_TYPES as readonly string[]).includes(canon)) return canon as EntityType;

  const compact = s.replace(/[^A-Z0-9]/g, '');

  // Non-profit before generic "corporation" (many nonprofits are incorporated).
  if (compact.includes('NONPROFIT') || compact.includes('NOTFORPROFIT') || s.includes('501(C)') || compact.includes('501C')) {
    return 'NONPROFIT';
  }
  // Sole proprietor / DBA.
  if (compact.includes('SOLEPROP') || compact.includes('SOLEPROPRIETOR') || compact.includes('DBA') || compact.includes('DOINGBUSINESSAS')) {
    return 'SOLE_PROP';
  }
  // S vs C corporation election.
  if (compact.includes('SCORP') || compact.includes('SUBCHAPTERS') || /\bS\s*CORP/.test(s)) return 'S_CORP';
  if (compact.includes('CCORP') || /\bC\s*CORP/.test(s)) return 'C_CORP';
  // Partnerships (LP / LLP / GP / general partnership).
  if (compact.includes('PARTNERSHIP') || compact === 'LP' || compact === 'LLP' || compact === 'GP') return 'PARTNERSHIP';
  // LLC — "limited liability company" / "L.L.C." (test before the bare "corporation" catch).
  if (compact.includes('LLC') || compact.includes('LIMITEDLIABILITYCOMPANY') || compact.includes('LIMITEDLIABILITYCO')) {
    return 'LLC';
  }
  // Generic corporation / incorporated → default to C_CORP (the default tax treatment
  // absent an S election). The human can re-elect S in review.
  if (compact.includes('CORPORATION') || compact.includes('INCORPORATED') || compact === 'INC' || compact === 'CORP' || compact.includes('PC') && compact.includes('PROFESSIONALCORP')) {
    return 'C_CORP';
  }
  return null;
}

/** USPS two-letter codes for resolving a spelled-out formation state. */
const STATE_CODES: Record<string, string> = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
  KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO',
  MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH',
  OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
  VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
  'DISTRICT OF COLUMBIA': 'DC', 'WASHINGTON DC': 'DC', 'WASHINGTON D.C.': 'DC', 'PUERTO RICO': 'PR',
};
const STATE_CODE_SET: ReadonlySet<string> = new Set(Object.values(STATE_CODES));

/** Normalize a formation state to its two-letter code when resolvable; else keep the raw name. */
export function mapState(raw: unknown): string | null {
  const s = toStringOrNull(raw);
  if (!s) return null;
  const upper = s.toUpperCase().replace(/\./g, '').trim();
  if (upper.length === 2 && STATE_CODE_SET.has(upper)) return upper;
  const byName = STATE_CODES[upper];
  if (byName) return byName;
  return s;
}

/** Normalize an EIN to NN-NNNNNNN when exactly 9 digits are present; else keep the trimmed raw. */
export function normalizeEin(raw: unknown): string | null {
  const s = toStringOrNull(raw);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 9) return `${digits.slice(0, 2)}-${digits.slice(2)}`;
  return s;
}

/* -------------------------------------------------------------------------- */
/* Members                                                                    */
/* -------------------------------------------------------------------------- */

/** Normalize the model's loose members array; drops entries with no usable name. */
export function normalizeMembers(raw: unknown): ProposedMember[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposedMember[] = [];
  for (const item of raw.slice(0, 50)) {
    const r = (item ?? {}) as Record<string, unknown>;
    const name = toStringOrNull(r.name ?? r.member ?? r.owner ?? r.full_name);
    if (!name) continue; // an unnamed member isn't a usable record
    out.push({
      name,
      role: toStringOrNull(r.role ?? r.title ?? r.capacity ?? r.position),
      ownership_pct: clampPct(r.ownership_pct ?? r.ownership ?? r.pct ?? r.percent ?? r.percentage),
    });
  }
  return out;
}

interface RawFormation {
  legal_name?: unknown;
  entity_type?: unknown;
  ein?: unknown;
  formation_state?: unknown;
  formation_date?: unknown;
  registered_agent?: unknown;
  members?: unknown;
  document_note?: unknown;
  snippet?: unknown;
  confidence?: unknown;
}

/**
 * Pure normalizer: turn the model's loose JSON into a validated ProposedFormation.
 * Maps the entity-type / state / EIN, keeps fields blank when undeterminable, clamps
 * ownership 0–100, and flags low-confidence / blank-but-important fields. Never throws.
 */
export function normalizeFormation(raw: unknown): ProposedFormation {
  const root = (raw ?? {}) as { formation?: RawFormation; legal_record?: RawFormation } & RawFormation;
  const f: RawFormation = (root.formation ?? root.legal_record ?? root) as RawFormation;

  const legal_name = toStringOrNull(f.legal_name) ?? '';
  const entity_type = mapEntityType(f.entity_type);
  const ein = normalizeEin(f.ein);
  const formation_state = mapState(f.formation_state);
  const formation_date = toIsoDate(f.formation_date);
  const registered_agent = toStringOrNull(f.registered_agent);
  const members = normalizeMembers(f.members);

  const c = (f.confidence ?? {}) as Record<string, unknown>;
  const confidence: Record<string, number> = {
    legal_name: conf(c.legal_name),
    entity_type: conf(c.entity_type),
    ein: conf(c.ein),
    formation_state: conf(c.formation_state),
    formation_date: conf(c.formation_date),
    registered_agent: conf(c.registered_agent),
  };

  const low: string[] = [];
  const flag = (present: boolean, key: string) => {
    if (!present) low.push(key);
    else if ((confidence[key] ?? 0) < LOW_CONFIDENCE) low.push(key);
  };
  flag(legal_name !== '', 'legal_name');
  flag(entity_type !== null, 'entity_type');
  flag(ein !== null, 'ein');
  flag(formation_state !== null, 'formation_state');
  flag(formation_date !== null, 'formation_date');

  return {
    legal_name,
    entity_type,
    ein,
    formation_state,
    formation_date,
    registered_agent,
    members,
    document_note: toStringOrNull(f.document_note),
    snippet: toStringOrNull(f.snippet),
    confidence,
    lowConfidenceFields: Array.from(new Set(low)),
  };
}

const EXTRACTION_PROMPT = `You are an expert corporate paralegal. Read this company FORMATION document — it may be an IRS EIN confirmation letter (CP 575 / SS-4), articles of organization or incorporation, a certificate of formation, or an operating agreement — and extract the LEGAL RECORD of the ONE company it forms.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "formation": {
    "legal_name": "string or null — the company's EXACT legal name as registered (include the suffix, e.g. 'Acme Holdings, LLC')",
    "entity_type": "LLC | C_CORP | S_CORP | PARTNERSHIP | SOLE_PROP | NONPROFIT | OTHER — the legal form. Use S_CORP only if an S-election is stated; a plain corporation is C_CORP. A nonprofit / 501(c) is NONPROFIT. A limited/general partnership (LP/LLP/GP) is PARTNERSHIP.",
    "ein": "string or null — the 9-digit Employer Identification Number (format NN-NNNNNNN)",
    "formation_state": "string or null — the U.S. state of formation/incorporation (two-letter code preferred, e.g. 'DE')",
    "formation_date": "YYYY-MM-DD or null — the date the entity was formed/incorporated (NOT the EIN assignment date unless that is all that is stated)",
    "registered_agent": "string or null — the registered agent's name (and address if given)",
    "members": [
      {
        "name": "string — the member / manager / shareholder / partner / director / officer legal name",
        "role": "string or null — their role/title as stated (e.g. 'Managing Member', 'President', 'General Partner', 'Director')",
        "ownership_pct": number or null — ownership as a PERCENT (50 for 50%), null if the document does not state ownership
      }
    ],
    "snippet": "string — a short VERBATIM excerpt naming the entity / EIN / state, for traceability",
    "document_note": "string or null — anything unusual (this is an amendment, a foreign registration, multiple entities, illegible/scanned, a draft)",
    "confidence": {
      "legal_name": number 0-1,
      "entity_type": number 0-1,
      "ein": number 0-1,
      "formation_state": number 0-1,
      "formation_date": number 0-1,
      "registered_agent": number 0-1
    }
  }
}

Rules:
- If a field is not stated in the document, use null and set its confidence to 0. NEVER invent a value.
- List EVERY named member / manager / shareholder / partner / director / officer you can find. If none are named, return an empty array [].
- Ownership as a percent number (50, not 0.5). If ownership is not stated, use null — do NOT split it evenly.
- If the document forms MORE than one entity, extract the primary one and note the others in document_note.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded formation document into a proposed legal record THROUGH the Core
 * AI gateway (metered, budget-capped per tenant; `orgId` scopes it, `userId`
 * attributes it). Accepts base64-encoded PDF or image. Never throws for expected
 * failure cases — returns `{ ok: false, ... }` so callers degrade cleanly.
 */
export async function parseFormationDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParseFormationResult> {
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
        feature: FORMATION_EXTRACT_FEATURE,
        model: FORMATION_EXTRACT_MODEL,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: EXTRACTION_PROMPT }] }],
        max_tokens: 2500,
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
    console.error('[formation-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const formation = normalizeFormation(parsed);
  const documentNote =
    parsed && typeof parsed === 'object'
      ? toStringOrNull((parsed as { document_note?: unknown }).document_note) ?? formation.document_note
      : formation.document_note;

  return {
    ok: true,
    formation,
    model: gw.model_used ?? FORMATION_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
