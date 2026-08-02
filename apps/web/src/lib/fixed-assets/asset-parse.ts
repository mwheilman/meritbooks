/**
 * Capex-invoice parser — DROP-AND-PARSE fixed-asset extraction.
 *
 * Takes an uploaded equipment / capital-expenditure invoice (PDF or image →
 * base64) and, THROUGH the Core AI gateway (`@meritbooks/core-ai`, feature
 * ASSET_EXTRACT, metered to core.ai_usage_log, tenant budget enforced across the
 * combined suite), extracts the purchased ASSET(S) and PROPOSES an asset class +
 * useful life + default book depreciation method for a human to confirm into the
 * fixed-asset register.
 *
 * Canon boundary (§2/§3): the AI PROPOSES facts — it never writes an asset and
 * never books a debit/credit. The model returns JSON validated by Zod-free pure
 * normalization here; the human reviews/edits/confirms every proposal, and only
 * the confirmed asset persists via the EXISTING gated create path
 * (`recordAssetAcquisition`, which posts the balanced GL and starts depreciation).
 * Anything the model can't determine is left BLANK for the human — never guessed.
 *
 * The class/life mapping, the capitalization-threshold flag, and cost
 * normalization are PURE and unit-tested with no gateway dependency
 * (`mapAssetClass`, `normalizeAssetExtraction`, `parseDollarsToCents`). The model
 * call itself lives in `parseAssetInvoice`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';

export const ASSET_EXTRACT_FEATURE = 'ASSET_EXTRACT';
export const ASSET_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

/**
 * Default capitalization threshold: the IRS de-minimis safe harbor without an
 * applicable financial statement ($2,500 = 250,000 cents). A line below this is
 * usually better EXPENSED than capitalized — we FLAG it (never auto-decide). A
 * tenant can pass its own book policy threshold at the call site.
 */
export const DEFAULT_CAPITALIZATION_THRESHOLD_CENTS = 250_000;

/** Book depreciation methods the deterministic create path (`recordAssetAcquisition`) accepts. */
export type BookDepreciationMethod = 'STRAIGHT_LINE' | 'DOUBLE_DECLINING' | 'UNITS_OF_PRODUCTION';
export const BOOK_METHOD_VALUES: readonly BookDepreciationMethod[] = [
  'STRAIGHT_LINE',
  'DOUBLE_DECLINING',
  'UNITS_OF_PRODUCTION',
];

export type AssetCategory =
  | 'COMPUTER'
  | 'SOFTWARE'
  | 'VEHICLE'
  | 'FURNITURE'
  | 'MACHINERY'
  | 'EQUIPMENT'
  | 'LEASEHOLD'
  | 'BUILDING'
  | 'OTHER';

export interface AssetClassRule {
  category: AssetCategory;
  /** Human-facing proposal label (shown in the review UI). */
  label: string;
  usefulLifeMonths: number;
  method: BookDepreciationMethod;
}

interface KeyedRule extends AssetClassRule {
  keywords: string[];
}

/**
 * Class map: common equipment/capex descriptions → { category, useful life,
 * default book method }. Lives are the GAAP/MACRS-conventional book lives
 * (computers 5yr, furniture 7yr, vehicles 5yr, machinery/equipment 7yr,
 * leasehold 15yr, buildings 39yr). Order matters — the FIRST rule whose keyword
 * appears wins, so more-specific classes are listed before broad ones
 * (leasehold before building; computer/vehicle before generic equipment).
 * STRAIGHT_LINE is the universal default book method; the human can switch to an
 * accelerated method in the review UI.
 */
const CLASS_RULES: readonly KeyedRule[] = [
  {
    category: 'COMPUTER',
    label: 'Computers & peripherals (5-yr)',
    usefulLifeMonths: 60,
    method: 'STRAIGHT_LINE',
    keywords: [
      'computer', 'laptop', 'desktop', 'macbook', 'imac', 'server', 'monitor',
      'printer', 'scanner', 'workstation', 'tablet', 'ipad', 'router', 'switch',
      'firewall', 'nas', 'gpu', 'network',
    ],
  },
  {
    category: 'SOFTWARE',
    label: 'Capitalized software (3-yr)',
    usefulLifeMonths: 36,
    method: 'STRAIGHT_LINE',
    keywords: ['software', 'perpetual license', 'erp system', 'operating system license'],
  },
  {
    category: 'VEHICLE',
    label: 'Vehicles (5-yr)',
    usefulLifeMonths: 60,
    method: 'STRAIGHT_LINE',
    keywords: [
      'vehicle', 'truck', 'van', 'pickup', 'sedan', 'automobile', 'car ', 'fleet', 'trailer',
    ],
  },
  {
    category: 'FURNITURE',
    label: 'Furniture & fixtures (7-yr)',
    usefulLifeMonths: 84,
    method: 'STRAIGHT_LINE',
    keywords: [
      'furniture', 'desk', 'chair', 'cabinet', 'shelving', 'workbench', 'cubicle',
      'sofa', 'filing', 'fixture', 'conference table',
    ],
  },
  {
    category: 'MACHINERY',
    label: 'Machinery (7-yr)',
    usefulLifeMonths: 84,
    method: 'STRAIGHT_LINE',
    keywords: [
      'machinery', 'machine', 'cnc', 'lathe', 'press', 'compressor', 'generator',
      'pump', 'forklift', 'excavator', 'loader', 'boiler', 'condenser', 'rooftop unit',
      'hvac unit', 'ac unit', 'furnace',
    ],
  },
  {
    category: 'EQUIPMENT',
    label: 'Equipment & tools (7-yr)',
    usefulLifeMonths: 84,
    method: 'STRAIGHT_LINE',
    keywords: ['equipment', 'tooling', 'tool', 'apparatus', 'instrument', 'welder', 'saw'],
  },
  {
    category: 'LEASEHOLD',
    label: 'Leasehold improvements (15-yr)',
    usefulLifeMonths: 180,
    method: 'STRAIGHT_LINE',
    keywords: ['leasehold', 'tenant improvement', 'build-out', 'buildout', 'tenant fit'],
  },
  {
    category: 'BUILDING',
    label: 'Building / real property (39-yr)',
    usefulLifeMonths: 468,
    method: 'STRAIGHT_LINE',
    keywords: ['building', 'real property', 'warehouse', 'facility', 'structure'],
  },
];

/** Fallback when nothing matches — a neutral 7-yr straight-line class. */
export const DEFAULT_ASSET_CLASS: AssetClassRule = {
  category: 'OTHER',
  label: 'Other depreciable asset (7-yr)',
  usefulLifeMonths: 84,
  method: 'STRAIGHT_LINE',
};

/**
 * Map free-form asset text (a model "type" hint plus the line description) onto a
 * proposed class + useful life + book method. Never throws; unknown → the neutral
 * 7-yr default. This is a PROPOSAL a human confirms — not a determination.
 */
export function mapAssetClass(rawType: unknown, description?: unknown): AssetClassRule {
  const parts: string[] = [];
  if (typeof rawType === 'string') parts.push(rawType);
  if (typeof description === 'string') parts.push(description);
  const hay = ` ${parts.join(' ').toLowerCase()} `;
  if (hay.trim() === '') return { ...DEFAULT_ASSET_CLASS };

  for (const rule of CLASS_RULES) {
    if (rule.keywords.some((k) => hay.includes(k))) {
      const { category, label, usefulLifeMonths, method } = rule;
      return { category, label, usefulLifeMonths, method };
    }
  }
  return { ...DEFAULT_ASSET_CLASS };
}

/**
 * Normalize a monetary value the model reports IN DOLLARS to integer bigint cents.
 * Accepts a number or a string with $, commas, whitespace. Returns null when not
 * a finite non-negative amount (never guesses). Money stays integer cents.
 */
export function parseDollarsToCents(raw: unknown): number | null {
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    const cleaned = raw.replace(/[$,\s]/g, '');
    if (cleaned === '') return null;
    n = Number(cleaned);
  } else {
    return null;
  }
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** ISO yyyy-mm-dd or null. Rejects malformed shapes AND impossible calendar dates. */
export function toIsoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return s;
}

function toStringOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s === '' ? null : s;
}

function toPositiveIntOrNull(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.round(n);
}

function conf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

const LOW_CONFIDENCE = 0.6;

/**
 * One proposed capitalizable asset, ready to seed the fixed-asset create form.
 * Fields the model could not determine are left blank (null) for the human.
 */
export interface ProposedAsset {
  /** Vendor / supplier on the invoice (informational; asset create doesn't store it). */
  vendorName: string | null;
  /** The asset description that becomes fixed_assets.name (human can edit). */
  name: string;
  /** The model's raw type phrase, kept for traceability of the class proposal. */
  rawAssetType: string | null;
  serialNumber: string | null;
  /** Units purchased (>= 1). */
  quantity: number;
  /** Total capitalizable cost of the line, in bigint cents. Null if undeterminable. */
  costCents: number | null;
  /** Per-unit cost in cents when the invoice broke it out (else null). */
  unitCostCents: number | null;
  purchaseDate: string | null;
  /** In-service date (depreciation start); defaults to purchase date downstream. */
  inServiceDate: string | null;

  // ── The PROPOSAL (human confirms) ──────────────────────────────────────────
  proposedCategory: AssetCategory;
  proposedClassLabel: string;
  usefulLifeMonths: number;
  depreciationMethod: BookDepreciationMethod;

  // ── Capitalize-vs-expense hint ─────────────────────────────────────────────
  capitalizationThresholdCents: number;
  /** True when cost is known AND below the capitalization threshold. */
  belowCapitalizationThreshold: boolean;
  /** Convenience alias of the above — the UI shows an "expense instead?" nudge. */
  suggestExpense: boolean;

  snippet: string | null;
  notes: string | null;
  confidence: Record<string, number>;
  /** Fields the UI should highlight (blank-but-required or low confidence). */
  lowConfidenceFields: string[];
}

interface RawAsset {
  description?: unknown;
  asset_type?: unknown;
  serial_number?: unknown;
  quantity?: unknown;
  total_cost?: unknown;
  unit_cost?: unknown;
  purchase_date?: unknown;
  in_service_date?: unknown;
  snippet?: unknown;
  note?: unknown;
  confidence?: unknown;
}

export interface NormalizeOptions {
  /** Book capitalization policy threshold in cents (default IRS de-minimis $2,500). */
  capitalizationThresholdCents?: number;
}

/**
 * Pure normalizer: turn the model's loose JSON into validated ProposedAssets.
 * Maps the class, normalizes cost to cents, flags below-threshold lines, and
 * marks low-confidence / blank-but-required fields. Never throws — a malformed
 * shape yields an empty list.
 */
export function normalizeAssetExtraction(raw: unknown, opts: NormalizeOptions = {}): ProposedAsset[] {
  const threshold = opts.capitalizationThresholdCents ?? DEFAULT_CAPITALIZATION_THRESHOLD_CENTS;
  const root = (raw ?? {}) as { vendor?: { name?: unknown }; assets?: unknown };
  const vendorName = toStringOrNull(root.vendor?.name);
  const list = Array.isArray(root.assets) ? (root.assets as RawAsset[]) : [];

  const out: ProposedAsset[] = [];
  for (const ra of list) {
    if (ra == null || typeof ra !== 'object') continue;

    const name = toStringOrNull(ra.description) ?? '';
    const rawAssetType = toStringOrNull(ra.asset_type);
    const quantity = toPositiveIntOrNull(ra.quantity) ?? 1;

    let costCents = parseDollarsToCents(ra.total_cost);
    const unitCostCents = parseDollarsToCents(ra.unit_cost);
    // Derive total from unit × qty when the line only broke out a unit price.
    if (costCents === null && unitCostCents !== null) {
      costCents = unitCostCents * quantity;
    }

    const klass = mapAssetClass(rawAssetType, name);

    const c = (ra.confidence ?? {}) as Record<string, unknown>;
    const confidence: Record<string, number> = {
      description: conf(c.description),
      asset_type: conf(c.asset_type),
      cost: conf(c.cost),
      date: conf(c.date),
    };

    const belowThreshold = costCents !== null && costCents < threshold;

    const low: string[] = [];
    if (!name) low.push('name');
    else if (confidence.description < LOW_CONFIDENCE) low.push('name');
    if (costCents === null) low.push('costCents');
    else if (confidence.cost < LOW_CONFIDENCE) low.push('costCents');
    if (toIsoDate(ra.purchase_date) === null && toIsoDate(ra.in_service_date) === null) {
      low.push('purchaseDate');
    }
    // The class is always a proposal to scrutinize when the type was unclear.
    if (klass.category === 'OTHER' || confidence.asset_type < LOW_CONFIDENCE) {
      low.push('proposedCategory');
    }

    out.push({
      vendorName,
      name,
      rawAssetType,
      serialNumber: toStringOrNull(ra.serial_number),
      quantity,
      costCents,
      unitCostCents,
      purchaseDate: toIsoDate(ra.purchase_date),
      inServiceDate: toIsoDate(ra.in_service_date),
      proposedCategory: klass.category,
      proposedClassLabel: klass.label,
      usefulLifeMonths: klass.usefulLifeMonths,
      depreciationMethod: klass.method,
      capitalizationThresholdCents: threshold,
      belowCapitalizationThreshold: belowThreshold,
      suggestExpense: belowThreshold,
      snippet: toStringOrNull(ra.snippet),
      notes: toStringOrNull(ra.note),
      confidence,
      lowConfidenceFields: Array.from(new Set(low)),
    });
  }

  return out;
}

export type ParseAssetResult =
  | {
      ok: true;
      assets: ProposedAsset[];
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

const EXTRACTION_PROMPT = `You are an expert fixed-asset accountant. Read this equipment / capital-expenditure invoice and extract EVERY CAPITALIZABLE asset it purchases.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "vendor": { "name": "string or null — the supplier/vendor on the invoice" },
  "assets": [
    {
      "description": "string — the asset as written on the invoice line (becomes the asset name)",
      "asset_type": "string or null — a short generic type you infer (e.g. 'laptop computer', 'delivery truck', 'CNC machine', 'office desk', 'HVAC rooftop unit')",
      "serial_number": "string or null — serial / VIN / model number if present",
      "quantity": number — units purchased (default 1),
      "unit_cost": number or null — per-unit price in WHOLE DOLLARS (not cents), null if not broken out,
      "total_cost": number or null — total CAPITALIZABLE cost of the line in WHOLE DOLLARS, INCLUDING freight/install/tax that should be capitalized into basis; null if not stated,
      "purchase_date": "YYYY-MM-DD or null — invoice/purchase date",
      "in_service_date": "YYYY-MM-DD or null — placed-in-service date if different from purchase",
      "snippet": "string — a short VERBATIM excerpt of the invoice line for traceability",
      "note": "string or null — anything notable (freight/install included, warranty bundled, etc.)",
      "confidence": {
        "description": number 0-1,
        "asset_type": number 0-1,
        "cost": number 0-1,
        "date": number 0-1
      }
    }
  ],
  "document_note": "string or null — anything unusual (scanned/illegible, this is a service invoice with nothing to capitalize, a deposit/partial, etc.)"
}

Rules:
- Capitalize the FULL cost basis: purchase price PLUS freight, installation, and non-recoverable tax that belong in the asset's basis.
- Do NOT list consumables, supplies, repairs/maintenance, or pure service charges as assets — only durable assets with a useful life beyond one year.
- Amounts in WHOLE DOLLARS, never cents. If a value is not stated, use null and set its confidence to 0. NEVER invent a value.
- If the document capitalizes NOTHING, return "assets": [] and explain in document_note.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded capex invoice into proposed assets THROUGH the Core AI gateway
 * (metered, budget-capped per tenant; `orgId` scopes it, `userId` attributes it).
 * Accepts base64-encoded PDF or image data. Never throws for the expected failure
 * cases — returns `{ ok: false, ... }` so callers degrade cleanly.
 */
export async function parseAssetInvoice(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: {
    orgId: string;
    userId?: string | null;
    base64Data: string;
    mediaType: string;
    capitalizationThresholdCents?: number;
  },
): Promise<ParseAssetResult> {
  const { supabase, anthropicApiKey } = deps;
  const { orgId, userId, base64Data, mediaType, capitalizationThresholdCents } = args;
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
        feature: ASSET_EXTRACT_FEATURE,
        model: ASSET_EXTRACT_MODEL,
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
    console.error('[asset-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const assets = normalizeAssetExtraction(parsed, { capitalizationThresholdCents });
  const documentNote =
    parsed && typeof parsed === 'object'
      ? toStringOrNull((parsed as { document_note?: unknown }).document_note)
      : null;

  return {
    ok: true,
    assets,
    model: gw.model_used ?? ASSET_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
