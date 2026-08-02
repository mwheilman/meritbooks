/**
 * Lease document parser — DROP-AND-PARSE lease extraction (ASC 842).
 *
 * Takes an uploaded lease agreement (PDF or image → base64) and, THROUGH the Core AI
 * gateway (`@meritbooks/core-ai`, feature LEASE_EXTRACT, metered to core.ai_usage_log,
 * tenant budget enforced across the combined suite), extracts the STRUCTURED lease
 * terms the schedule engine needs: lessor, commencement/end dates, the periodic
 * payment, its frequency, and any stated discount / incremental borrowing rate. It
 * also SUGGESTS a classification (operating vs finance) — the human confirms it.
 *
 * Canon §2/§3 boundary: the AI PROPOSES facts — it never writes a lease, an ROU
 * asset, a liability, or a journal line. The model returns JSON that Zod-free
 * `normalizeLeaseExtraction` validates and normalizes here; anything the model can't
 * determine is left BLANK for the human — never guessed. Only the confirmed terms
 * persist, via the gated `POST /api/leases` create path.
 *
 * The model call lives in `parseLeaseDocument`; the pure, deterministic
 * `normalizeLeaseExtraction` is exported separately (no gateway dependency).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import type { LeaseClassification, LeaseFrequency, PaymentTiming } from './schedule';

export const LEASE_EXTRACT_FEATURE = 'LEASE_EXTRACT';
export const LEASE_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

const LOW_CONFIDENCE = 0.6;

/**
 * One proposed lease, mapped onto the `leases` fields + what the schedule engine
 * needs. Blank (null) where the model could not determine a value — never guessed.
 */
export interface ProposedLease {
  lessor: string | null;
  description: string | null;
  classification: LeaseClassification;
  commencement_date: string | null;
  end_date: string | null;
  /** Whole dollars per period (NOT cents) — the review UI converts to cents on confirm. */
  payment_dollars: number | null;
  payment_frequency: LeaseFrequency | null;
  payment_timing: PaymentTiming;
  /** Whole-month term (derived from dates when both are present). */
  term_months: number | null;
  /** Discount / incremental borrowing rate as a decimal (0.06 = 6%), or null. */
  discount_rate: number | null;
  notes: string | null;
  snippet: string | null;
  confidence: Record<string, number>;
  lowConfidenceFields: string[];
}

export type ParseLeaseResult =
  | {
      ok: true;
      lease: ProposedLease;
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

/** Map free-form classification language onto the enum. Default OPERATING. */
export function mapClassification(raw: unknown): LeaseClassification {
  if (typeof raw !== 'string') return 'OPERATING';
  const s = raw.trim().toUpperCase();
  if (s.includes('FINANCE') || s.includes('CAPITAL')) return 'FINANCE';
  return 'OPERATING';
}

function toFrequency(raw: unknown): LeaseFrequency | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (s.startsWith('MONTH')) return 'MONTHLY';
  if (s.startsWith('QUART') || s.includes('QTR')) return 'QUARTERLY';
  if (s.startsWith('ANNUAL') || s.startsWith('YEAR') || s.includes('ANNUM')) return 'ANNUAL';
  return null;
}

function toTiming(raw: unknown): PaymentTiming {
  if (typeof raw === 'string') {
    const s = raw.trim().toUpperCase();
    if (s.includes('ADVANCE') || s.includes('BEGIN') || s.includes('DUE ON THE FIRST')) return 'ADVANCE';
  }
  return 'ARREARS';
}

/** ISO yyyy-mm-dd or null (rejects malformed + impossible calendar dates). */
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

/** Whole months between two ISO dates (end exclusive of the extra day). */
function monthsBetween(start: string, end: string): number | null {
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) return null;
  let months = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
  if (e.getUTCDate() >= s.getUTCDate()) months += 0; // whole months from the anchor day
  return months > 0 ? months : null;
}

/**
 * Normalize a rate the model may state as a percent (6) or a decimal (0.06).
 * Values > 1 are treated as a percentage and divided by 100. Clamped to [0, 1).
 */
function toRateDecimal(raw: unknown): number | null {
  const n = toNumberOrNull(raw);
  if (n === null || n < 0) return null;
  const dec = n > 1 ? n / 100 : n;
  return dec >= 0 && dec < 1 ? dec : null;
}

interface RawLease {
  lessor?: unknown;
  description?: unknown;
  classification?: unknown;
  commencement_date?: unknown;
  end_date?: unknown;
  payment_amount?: unknown;
  payment_frequency?: unknown;
  payment_timing?: unknown;
  term_months?: unknown;
  discount_rate?: unknown;
  measurement_note?: unknown;
  snippet?: unknown;
  confidence?: unknown;
}

/**
 * Pure normalizer: turn the model's loose JSON into a validated ProposedLease.
 * Enum-maps the classification/frequency, keeps unknowns blank, derives term from
 * the dates when both are present, and flags low-confidence / blank-but-required
 * fields. Never throws — a malformed shape yields a blank proposal.
 */
export function normalizeLeaseExtraction(raw: unknown): ProposedLease {
  const rc = (raw && typeof raw === 'object' ? (raw as { lease?: RawLease }).lease ?? raw : {}) as RawLease;

  const classification = mapClassification(rc.classification);
  const commencement_date = toIsoDate(rc.commencement_date);
  const end_date = toIsoDate(rc.end_date);
  const payment_dollars = toNumberOrNull(rc.payment_amount);
  const payment_frequency = toFrequency(rc.payment_frequency);
  const payment_timing = toTiming(rc.payment_timing);
  const discount_rate = toRateDecimal(rc.discount_rate);

  let term_months = toNumberOrNull(rc.term_months);
  if ((term_months === null || term_months <= 0) && commencement_date && end_date) {
    term_months = monthsBetween(commencement_date, end_date);
  }
  if (term_months !== null) term_months = Math.round(term_months);

  const c = (rc.confidence ?? {}) as Record<string, unknown>;
  const confidence: Record<string, number> = {
    lessor: conf(c.lessor),
    classification: conf(c.classification),
    dates: conf(c.dates),
    payment_amount: conf(c.payment_amount),
    payment_frequency: conf(c.payment_frequency),
    discount_rate: conf(c.discount_rate),
  };

  const low: string[] = [];
  const lessor = toStringOrNull(rc.lessor);
  if (!lessor) low.push('lessor');
  else if (confidence.lessor < LOW_CONFIDENCE) low.push('lessor');
  if (payment_dollars === null || !(payment_dollars > 0)) low.push('payment_amount');
  else if (confidence.payment_amount < LOW_CONFIDENCE) low.push('payment_amount');
  if (payment_frequency === null) low.push('payment_frequency');
  if (!commencement_date) low.push('commencement_date');
  if (!end_date) low.push('end_date');
  if (term_months === null || term_months <= 0) low.push('term_months');
  if (discount_rate === null) low.push('discount_rate'); // the borrowing rate is often not in the lease
  if (confidence.classification < LOW_CONFIDENCE) low.push('classification');

  return {
    lessor,
    description: toStringOrNull(rc.description),
    classification,
    commencement_date,
    end_date,
    payment_dollars: payment_dollars !== null && payment_dollars > 0 ? payment_dollars : null,
    payment_frequency,
    payment_timing,
    term_months: term_months !== null && term_months > 0 ? term_months : null,
    discount_rate,
    notes: toStringOrNull(rc.measurement_note),
    snippet: toStringOrNull(rc.snippet),
    confidence,
    lowConfidenceFields: Array.from(new Set(low)),
  };
}

const EXTRACTION_PROMPT = `You are an expert lease accountant applying ASC 842. Read this lease agreement (the reader is the LESSEE) and extract the key terms needed to set up the right-of-use asset and lease liability.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "lease": {
    "lessor": "string or null — the landlord / lessor name",
    "description": "string or null — the leased asset (e.g. 'Warehouse, 1200 Industrial Pkwy' or '2024 Freightliner truck')",
    "classification": "OPERATING | FINANCE — suggest FINANCE if it transfers ownership, has a bargain purchase option, the term is a major part of the asset's economic life, or the PV of payments is substantially all of fair value; otherwise OPERATING",
    "commencement_date": "YYYY-MM-DD or null — lease commencement date",
    "end_date": "YYYY-MM-DD or null — lease expiration date",
    "payment_amount": number or null — the periodic base rent/payment in WHOLE DOLLARS (not cents),
    "payment_frequency": "MONTHLY | QUARTERLY | ANNUAL or null",
    "payment_timing": "ARREARS | ADVANCE — ADVANCE if rent is due at the start of each period (e.g. 'on the first of the month'), else ARREARS",
    "term_months": number or null — total lease term in whole months if stated,
    "discount_rate": number or null — a stated interest / discount / incremental borrowing rate as a percent (e.g. 6 for 6%); null if the lease does not state one,
    "measurement_note": "string or null — anything relevant (escalations, free-rent, options, section reference)",
    "snippet": "string — a short VERBATIM excerpt naming the payment + term, for traceability",
    "confidence": {
      "lessor": number 0-1,
      "classification": number 0-1,
      "dates": number 0-1,
      "payment_amount": number 0-1,
      "payment_frequency": number 0-1,
      "discount_rate": number 0-1
    }
  },
  "document_note": "string or null — anything unusual (scanned/illegible, draft, amendment, variable rent only)"
}

Rules:
- If a field is not stated in the document, use null and set its confidence to 0. NEVER invent a value.
- Payment in WHOLE DOLLARS. The discount rate as a percent number (6, not 0.06). Dates as YYYY-MM-DD.
- Extract the BASE periodic rent. Ignore variable/percentage rent, CAM, and taxes for the schedule.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded lease document into a proposed lease THROUGH the Core AI gateway
 * (metered, budget-capped per tenant; `orgId` scopes it, `userId` attributes it).
 * Accepts base64-encoded PDF or image data. Never throws for expected failures —
 * returns `{ ok: false, ... }` so callers degrade cleanly.
 */
export async function parseLeaseDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParseLeaseResult> {
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
        feature: LEASE_EXTRACT_FEATURE,
        model: LEASE_EXTRACT_MODEL,
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
    console.error('[lease-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const lease = normalizeLeaseExtraction(parsed);
  const documentNote =
    parsed && typeof parsed === 'object'
      ? toStringOrNull((parsed as { document_note?: unknown }).document_note)
      : null;

  return {
    ok: true,
    lease,
    model: gw.model_used ?? LEASE_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
