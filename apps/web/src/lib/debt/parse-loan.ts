/**
 * Loan document parser — DROP-AND-PARSE debt extraction.
 *
 * Takes an uploaded loan / promissory note / credit agreement (PDF or image →
 * base64) and, THROUGH the Core AI gateway (`@meritbooks/core-ai`, feature
 * DEBT_EXTRACT, metered to core.ai_usage_log, tenant budget enforced across the
 * combined suite), extracts the STRUCTURED terms of ONE debt instrument mapped to
 * the `debt_instruments` fields (migration 083).
 *
 * Canon boundary (§2/§3): the AI PROPOSES facts — it never creates an instrument or
 * writes a schedule. The model returns JSON that is validated by Zod-adjacent
 * normalization here; the human reviews/edits/confirms, and only the confirmed
 * terms persist via the gated `POST /api/debt` create path (which then generates
 * the amortization schedule deterministically). Anything the model can't determine
 * is left BLANK for the human — never guessed.
 *
 * `parseLoanDocument` makes the model call; the pure `normalizeLoanExtraction`
 * (enum mapping + blank-on-unknown + confidence flags) is exported separately and
 * unit-tested with no gateway dependency.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import type { AmortizationMethod, PaymentFrequency } from './amortization';

export const DEBT_EXTRACT_FEATURE = 'DEBT_EXTRACT';
export const DEBT_EXTRACT_MODEL = 'claude-sonnet-4-6';

export type RateType = 'FIXED' | 'VARIABLE';

/**
 * A proposed debt instrument mapped onto `debt_instruments`. Dollar amounts are
 * WHOLE DOLLARS as the model reads them (the confirm path converts to cents);
 * fields the model could not determine are null for the human to complete.
 */
/** Financial covenant types the parser can propose (mirrors lib/covenants/schema). */
export type CovenantType =
  | 'DSCR' | 'FCCR' | 'LEVERAGE' | 'CURRENT_RATIO' | 'MIN_LIQUIDITY' | 'TNW' | 'CUSTOM';
export type CovenantDirection = 'MIN' | 'MAX';
export type CovenantFrequency = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';

/**
 * A covenant the model detected in the loan document — proposed for review and,
 * on confirm, created + linked to the loan in the same step (no re-upload).
 */
export interface ProposedCovenant {
  covenant_type: CovenantType;
  /** The numeric threshold (e.g. 1.10 for a 1.10:1 DSCR, or dollars for MIN_LIQUIDITY). */
  threshold: number | null;
  /** MIN = must stay at/above; MAX = must stay at/below. Defaulted by type. */
  direction: CovenantDirection;
  test_frequency: CovenantFrequency;
  /** Short human label (e.g. "Debt Service Coverage Ratio"). */
  label: string | null;
  /** Verbatim excerpt stating the covenant, for traceability. */
  snippet: string | null;
}

export interface ProposedLoan {
  loan_name: string;
  lender: string | null;
  facility: string | null;
  /** Original principal in WHOLE DOLLARS (not cents). Null if not stated. */
  principal: number | null;
  /** Annual interest rate as a PERCENT (7.5 = 7.5%). Null if not stated. */
  interest_rate: number | null;
  rate_type: RateType;
  amortization_method: AmortizationMethod;
  payment_frequency: PaymentFrequency;
  compounding: PaymentFrequency;
  /** Number of amortization periods (term). Null if not stated. */
  term_periods: number | null;
  /** Scheduled level payment in WHOLE DOLLARS. Null if not stated. */
  payment: number | null;
  origination_date: string | null;
  maturity_date: string | null;
  notes: string | null;
  snippet: string | null;
  /** Financial covenants detected in the document (may be empty). */
  covenants: ProposedCovenant[];
  confidence: Record<string, number>;
  lowConfidenceFields: string[];
}

export type ParseLoanResult =
  | {
      ok: true;
      loan: ProposedLoan;
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

const FREQUENCIES: ReadonlySet<PaymentFrequency> = new Set(['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']);
const LOW_CONFIDENCE = 0.6;

export function mapFrequency(raw: unknown): PaymentFrequency {
  if (typeof raw !== 'string') return 'MONTHLY';
  const s = raw.trim().toUpperCase();
  // Substring (not prefix) matching so free-form cadences like "per quarter",
  // "paid monthly", or "due each year" map correctly. SEMI is tested before
  // ANNUAL so "semi-annual" isn't captured as ANNUAL.
  if (s.includes('MONTH')) return 'MONTHLY';
  if (s.includes('QUART') || s.includes('QTR')) return 'QUARTERLY';
  if (s.includes('SEMI') || s.includes('BIANNUAL')) return 'SEMIANNUAL';
  if (s.includes('ANNUAL') || s.includes('YEAR') || s.includes('ANNUM')) return 'ANNUAL';
  if (FREQUENCIES.has(s as PaymentFrequency)) return s as PaymentFrequency;
  return 'MONTHLY';
}

export function mapRateType(raw: unknown): RateType {
  if (typeof raw !== 'string') return 'FIXED';
  const s = raw.trim().toUpperCase();
  if (s.includes('VARIABLE') || s.includes('FLOAT') || s.includes('ADJUST') || s.includes('SOFR') || s.includes('PRIME') || s.includes('LIBOR')) {
    return 'VARIABLE';
  }
  return 'FIXED';
}

export function mapMethod(raw: unknown): AmortizationMethod {
  if (typeof raw !== 'string') return 'AMORTIZING';
  const s = raw.trim().toUpperCase();
  if (s.includes('INTEREST') && s.includes('ONLY')) return 'INTEREST_ONLY';
  if (s.includes('INTEREST_ONLY') || s.includes('BALLOON')) return 'INTEREST_ONLY';
  return 'AMORTIZING';
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

function toIntOrNull(raw: unknown): number | null {
  const n = toNumberOrNull(raw);
  if (n === null) return null;
  return Number.isInteger(n) ? n : Math.round(n);
}

function toStringOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s === '' ? null : s;
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

interface RawLoan {
  loan_name?: unknown;
  lender?: unknown;
  facility?: unknown;
  principal?: unknown;
  interest_rate?: unknown;
  rate_type?: unknown;
  amortization_method?: unknown;
  payment_frequency?: unknown;
  compounding?: unknown;
  term_periods?: unknown;
  term_months?: unknown;
  payment?: unknown;
  origination_date?: unknown;
  maturity_date?: unknown;
  notes?: unknown;
  snippet?: unknown;
  covenants?: unknown;
  confidence?: unknown;
}

const COVENANT_TYPE_SET: readonly CovenantType[] = [
  'DSCR', 'FCCR', 'LEVERAGE', 'CURRENT_RATIO', 'MIN_LIQUIDITY', 'TNW', 'CUSTOM',
];

/** Covenant types where the borrower must stay AT OR ABOVE the threshold. */
const MIN_TYPES: readonly CovenantType[] = ['DSCR', 'FCCR', 'CURRENT_RATIO', 'MIN_LIQUIDITY', 'TNW'];

function mapCovenantType(raw: unknown): CovenantType {
  const s = String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (s.includes('DSCR') || s.includes('DEBTSERVICE')) return 'DSCR';
  if (s.includes('FCCR') || s.includes('FIXEDCHARGE')) return 'FCCR';
  if (s.includes('LEVERAGE') || s.includes('DEBTTOEBITDA') || s.includes('DEBTEBITDA')) return 'LEVERAGE';
  if (s.includes('CURRENTRATIO')) return 'CURRENT_RATIO';
  if (s.includes('LIQUIDITY') || s.includes('MINCASH')) return 'MIN_LIQUIDITY';
  if (s.includes('TANGIBLENETWORTH') || s === 'TNW' || s.includes('NETWORTH')) return 'TNW';
  if (COVENANT_TYPE_SET.includes(s as CovenantType)) return s as CovenantType;
  return 'CUSTOM';
}

function mapCovenantFrequency(raw: unknown): CovenantFrequency {
  const s = String(raw ?? '').toUpperCase();
  if (s.startsWith('MONTH')) return 'MONTHLY';
  if (s.startsWith('ANNUAL') || s.startsWith('YEAR')) return 'ANNUAL';
  return 'QUARTERLY';
}

/** Normalize the model's loose covenant array; drops entries with no numeric threshold. */
export function normalizeCovenants(raw: unknown): ProposedCovenant[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposedCovenant[] = [];
  for (const item of raw.slice(0, 10)) {
    const r = (item ?? {}) as Record<string, unknown>;
    const covenant_type = mapCovenantType(r.covenant_type ?? r.type ?? r.name);
    const threshold = toNumberOrNull(r.threshold ?? r.value ?? r.ratio ?? r.minimum ?? r.maximum);
    if (threshold === null) continue; // a covenant with no testable number isn't actionable
    const dirRaw = String(r.direction ?? '').toUpperCase();
    const direction: CovenantDirection =
      dirRaw === 'MIN' || dirRaw === 'MAX'
        ? (dirRaw as CovenantDirection)
        : MIN_TYPES.includes(covenant_type) ? 'MIN' : 'MAX';
    out.push({
      covenant_type,
      threshold,
      direction,
      test_frequency: mapCovenantFrequency(r.test_frequency ?? r.frequency),
      label: toStringOrNull(r.label ?? r.name),
      snippet: toStringOrNull(r.snippet),
    });
  }
  return out;
}

/**
 * Pure normalizer: turn the model's loose JSON into a validated ProposedLoan.
 * Maps the enums, keeps amounts/dates blank when undeterminable, and flags
 * low-confidence / blank-but-required fields. Never throws.
 */
export function normalizeLoanExtraction(raw: unknown): ProposedLoan {
  const root = (raw ?? {}) as { loan?: RawLoan } & RawLoan;
  const l: RawLoan = (root.loan ?? root) as RawLoan;

  const frequency = mapFrequency(l.payment_frequency);
  const rate_type = mapRateType(l.rate_type);
  const amortization_method = mapMethod(l.amortization_method);

  // A term stated in months maps to periods when the schedule is monthly; when the
  // frequency differs we only trust an explicit `term_periods`.
  let term_periods = toIntOrNull(l.term_periods);
  if (term_periods === null && frequency === 'MONTHLY') term_periods = toIntOrNull(l.term_months);

  const principal = toNumberOrNull(l.principal);
  const interest_rate = toNumberOrNull(l.interest_rate);
  const payment = toNumberOrNull(l.payment);

  const c = (l.confidence ?? {}) as Record<string, unknown>;
  const confidence: Record<string, number> = {
    loan_name: conf(c.loan_name),
    principal: conf(c.principal),
    interest_rate: conf(c.interest_rate),
    payment: conf(c.payment),
    term: conf(c.term),
    dates: conf(c.dates),
  };

  const loan_name = toStringOrNull(l.loan_name) ?? '';

  const low: string[] = [];
  if (!loan_name) low.push('loan_name');
  else if (confidence.loan_name < LOW_CONFIDENCE) low.push('loan_name');
  if (principal === null) low.push('principal');
  else if (confidence.principal < LOW_CONFIDENCE) low.push('principal');
  if (interest_rate === null) low.push('interest_rate');
  else if (confidence.interest_rate < LOW_CONFIDENCE) low.push('interest_rate');
  // Need a term OR a payment to build a schedule; flag both when neither is present.
  if (term_periods === null && payment === null) {
    low.push('term_periods');
    low.push('payment');
  }

  return {
    loan_name,
    lender: toStringOrNull(l.lender),
    facility: toStringOrNull(l.facility),
    principal,
    interest_rate,
    rate_type,
    amortization_method,
    payment_frequency: frequency,
    compounding: mapFrequency(l.compounding ?? l.payment_frequency),
    term_periods,
    payment,
    origination_date: toIsoDate(l.origination_date),
    maturity_date: toIsoDate(l.maturity_date),
    notes: toStringOrNull(l.notes),
    snippet: toStringOrNull(l.snippet),
    covenants: normalizeCovenants(l.covenants),
    confidence,
    lowConfidenceFields: Array.from(new Set(low)),
  };
}

const EXTRACTION_PROMPT = `You are an expert corporate credit analyst. Read this loan agreement / promissory note / credit agreement and extract the terms of the debt instrument it defines.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "loan": {
    "loan_name": "string or null — the loan/facility name (e.g. 'Term Loan A', 'SBA 7(a) Loan')",
    "lender": "string or null — the lender / bank / administrative agent",
    "facility": "string or null — a short facility description (e.g. '$5M Senior Secured Term Loan')",
    "principal": number or null — the ORIGINAL principal / face amount in WHOLE DOLLARS (5000000), NOT cents,
    "interest_rate": number or null — the annual interest rate as a PERCENT (7.5 for 7.5%). For a variable rate, use the current all-in rate if stated,
    "rate_type": "FIXED | VARIABLE",
    "amortization_method": "AMORTIZING | INTEREST_ONLY — INTEREST_ONLY when the note pays interest only with a principal balloon at maturity",
    "payment_frequency": "MONTHLY | QUARTERLY | SEMIANNUAL | ANNUAL — how often payments are due",
    "compounding": "MONTHLY | QUARTERLY | SEMIANNUAL | ANNUAL or null",
    "term_periods": number or null — the number of PAYMENTS/periods over the life of the loan (e.g. a 5-year monthly loan = 60),
    "term_months": number or null — the term in months if that is how it is stated,
    "payment": number or null — the scheduled periodic payment in WHOLE DOLLARS, if the document states a fixed payment,
    "origination_date": "YYYY-MM-DD or null — funding / closing date",
    "maturity_date": "YYYY-MM-DD or null",
    "notes": "string or null — anything material (prepayment penalty, guaranty, collateral, rate index)",
    "snippet": "string — a short VERBATIM excerpt stating the principal/rate/term, for traceability",
    "covenants": [
      {
        "covenant_type": "DSCR | FCCR | LEVERAGE | CURRENT_RATIO | MIN_LIQUIDITY | TNW | CUSTOM — the financial covenant the document imposes",
        "threshold": number or null — the tested value (e.g. 1.10 for a 1.10:1 DSCR minimum; a DOLLAR amount for MIN_LIQUIDITY/TNW),
        "direction": "MIN | MAX — MIN if the borrower must stay at/above the number (DSCR, current ratio, liquidity, net worth); MAX if at/below (leverage / debt-to-EBITDA)",
        "test_frequency": "MONTHLY | QUARTERLY | ANNUAL — how often it is tested",
        "label": "string or null — the covenant's name as written (e.g. 'Debt Service Coverage Ratio')",
        "snippet": "string — a short VERBATIM excerpt stating this covenant"
      }
    ],
    "confidence": {
      "loan_name": number 0-1,
      "principal": number 0-1,
      "interest_rate": number 0-1,
      "payment": number 0-1,
      "term": number 0-1,
      "dates": number 0-1
    }
  },
  "document_note": "string or null — anything unusual (scanned/illegible, draft, amendment, multiple loans found)"
}

Rules:
- If a field is not stated in the document, use null and set its confidence to 0. NEVER invent a value.
- COVENANTS: include every financial covenant the document imposes (DSCR/FCCR minimums, leverage/debt-to-EBITDA maximums, current-ratio, minimum liquidity/cash, tangible net worth). Extract the exact tested number as \`threshold\`. If the document imposes no financial covenants, return an empty array [].
- Principal and payment in WHOLE DOLLARS. Interest rate as a percent number (not a decimal fraction).
- If the document defines MORE than one loan, extract the primary/largest and note the others in document_note.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded loan document into a proposed instrument THROUGH the Core AI
 * gateway (metered, budget-capped per tenant; `orgId` scopes it, `userId`
 * attributes it). Accepts base64-encoded PDF or image. Never throws for expected
 * failure cases — returns `{ ok: false, ... }` so callers degrade cleanly.
 */
export async function parseLoanDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParseLoanResult> {
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
        feature: DEBT_EXTRACT_FEATURE,
        model: DEBT_EXTRACT_MODEL,
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
    console.error('[debt-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const loan = normalizeLoanExtraction(parsed);
  const documentNote =
    parsed && typeof parsed === 'object'
      ? toStringOrNull((parsed as { document_note?: unknown }).document_note)
      : null;

  return {
    ok: true,
    loan,
    model: gw.model_used ?? DEBT_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
