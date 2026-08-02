/**
 * Contract / SOW parser — DROP-AND-PARSE billing extraction.
 *
 * Takes an uploaded signed customer contract or statement of work (PDF or image →
 * base64) and, THROUGH the Core AI gateway (`@meritbooks/core-ai`, feature
 * CONTRACT_EXTRACT, metered to core.ai_usage_log, tenant budget enforced across the
 * combined suite), extracts the billing terms as a STRUCTURED proposal: the
 * customer, total contract value, the billing schedule (one-time / milestone /
 * recurring), the term dates, and the revenue-recognition signals — from which it
 * SUGGESTS one of the nine Books rev-rec methods (rev-rec.ts is the authority).
 *
 * Canon boundary (§2/§3): the AI PROPOSES facts — it never writes an invoice or a
 * rev-rec decision. The model returns JSON that is validated by Zod-free deterministic
 * normalization here; the human reviews/edits/confirms every proposal, and only the
 * confirmed rows persist via the EXISTING gated create paths (`POST /api/invoices`
 * for one-time/milestone invoices, `POST /api/recurring-invoices` for a recurring
 * schedule). Nothing the model can't determine is guessed — it is left blank/flagged
 * for the human.
 *
 * The model call lives in `parseContractDocument`; the pure, deterministic
 * normalizer (`normalizeContractExtraction`) plus its helpers (`mapCadence`,
 * `suggestRevRecMethod`, `normalizeCustomerName`) are exported separately and
 * unit-tested with no gateway dependency. Money is bigint cents throughout — the
 * model returns whole dollars and this module converts once, at the boundary.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import type { RevRecMethod } from '@/lib/services/rev-rec';
import type { RecurringFrequency } from '@/lib/invoices/recurring-invoices';

export const CONTRACT_EXTRACT_FEATURE = 'CONTRACT_EXTRACT';
export const CONTRACT_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

/** How the contract bills. Drives whether we propose invoice(s) or a recurring schedule. */
export type BillingKind = 'ONE_TIME' | 'MILESTONE' | 'RECURRING';

/** Recognition timing signal the model reports; mapped to a rev-rec method. */
export type RevRecTiming = 'POINT_IN_TIME' | 'OVER_TIME' | 'UNKNOWN';

/** Recognition pattern the model reports; the primary rev-rec-method signal. */
export type RevRecPattern =
  | 'PCT_COMPLETE'
  | 'PCT_COSTS_INCURRED'
  | 'STRAIGHT_LINE'
  | 'MILESTONE'
  | 'COMPLETED_CONTRACT'
  | 'AS_BILLED'
  | 'POINT_IN_TIME'
  | 'CASH'
  | 'UNKNOWN';

/** A proposed invoice line — money is bigint cents. */
export interface ProposedLineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
  amount_cents: number;
}

/** A proposed milestone bill (one invoice per milestone on confirm). */
export interface ProposedMilestone {
  name: string;
  description: string | null;
  /** ISO yyyy-mm-dd or null when the contract did not state a date. */
  due_date: string | null;
  amount_cents: number;
}

/** A proposed recurring schedule (one recurring template on confirm). */
export interface ProposedRecurring {
  cadence: RecurringFrequency;
  interval_count: number;
  /** Amount billed each period, bigint cents. */
  amount_cents: number;
  start_date: string | null;
  end_date: string | null;
  /** Total number of periods when the contract is finite (null = open-ended). */
  occurrences: number | null;
}

/** The suggested rev-rec treatment — one of the nine methods, with its rationale. */
export interface RevRecSuggestion {
  method: RevRecMethod;
  timing: RevRecTiming;
  pattern: RevRecPattern;
  /** Whether issuing the bill IS the recognition event (else revenue defers to 2410). */
  recognizesAtBilling: boolean;
  reasoning: string | null;
  confidence: number;
}

/** The proposed customer, before matching against the tenant's customer list. */
export interface ProposedCustomer {
  name: string | null;
  email: string | null;
  /** Normalized key used to match against existing customers (lower, de-suffixed). */
  matchKey: string;
}

/** The fully-normalized contract proposal returned to the review UI. */
export interface NormalizedContract {
  customer: ProposedCustomer;
  contract_title: string | null;
  total_contract_value_cents: number | null;
  start_date: string | null;
  end_date: string | null;
  currency: string | null;
  billing_kind: BillingKind;
  /** Default line items (one-time invoice, or the per-period recurring line). */
  line_items: ProposedLineItem[];
  /** Populated only when billing_kind === 'MILESTONE'. */
  milestones: ProposedMilestone[];
  /** Populated only when billing_kind === 'RECURRING'. */
  recurring: ProposedRecurring | null;
  rev_rec: RevRecSuggestion;
  /** Per-field model confidence, 0..1. */
  confidence: Record<string, number>;
  /** Fields the UI should highlight (blank-but-needed or low confidence). */
  lowConfidenceFields: string[];
  /** Free-form model note (e.g. "scanned, some pages illegible"). */
  notes: string | null;
}

export type ParseContractResult =
  | {
      ok: true;
      contract: NormalizedContract;
      model: string;
      correlationId: string | null;
      extractionMs: number;
      documentNote: string | null;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested, no DB / no gateway)
// ─────────────────────────────────────────────────────────────────────────────

const LOW_CONFIDENCE = 0.6;

/** Company suffixes stripped when normalizing a customer name for matching. */
const COMPANY_SUFFIXES = [
  'incorporated', 'inc', 'corporation', 'corp', 'company', 'co', 'llc', 'l l c',
  'llp', 'lp', 'ltd', 'limited', 'plc', 'pllc', 'gmbh', 'the',
];

/**
 * Normalize a customer name into a match key: lowercase, strip punctuation,
 * drop common legal suffixes, collapse whitespace. Deterministic — used to
 * match a proposed customer against the tenant's existing customer list so the
 * same company under a slightly different spelling ("Acme, Inc." vs "Acme LLC")
 * still resolves. Returns '' for empty/garbage input.
 */
export function normalizeCustomerName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let s = raw.toLowerCase();
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9\s]/g, ' '); // drop punctuation
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // Iteratively strip trailing/leading company suffix tokens.
  let tokens = s.split(' ');
  let changed = true;
  while (changed && tokens.length > 1) {
    changed = false;
    const last = tokens[tokens.length - 1];
    if (COMPANY_SUFFIXES.includes(last)) {
      tokens = tokens.slice(0, -1);
      changed = true;
      continue;
    }
    const first = tokens[0];
    if (first === 'the') {
      tokens = tokens.slice(1);
      changed = true;
    }
  }
  return tokens.join(' ').trim();
}

/** Map free-form cadence language onto a RecurringFrequency. Unknown => null. */
export function mapCadence(raw: unknown): RecurringFrequency | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const has = (...needles: string[]) => needles.some((n) => s.includes(n));

  // Order: check the more specific / longer-period phrasings first.
  if (has('BIWEEK', 'BI WEEK', 'EVERY OTHER WEEK', 'FORTNIGHT')) return 'BIWEEKLY';
  if (has('SEMIANNUAL', 'SEMI ANNUAL', 'SEMI YEAR', 'TWICE A YEAR', 'EVERY SIX MONTH', 'EVERY 6 MONTH')) return 'SEMIANNUAL';
  if (has('QUARTER', 'QTR', 'EVERY THREE MONTH', 'EVERY 3 MONTH')) return 'QUARTERLY';
  if (has('ANNUAL', 'YEARLY', 'PER YEAR', 'PER ANNUM', 'EVERY YEAR')) return 'ANNUAL';
  if (has('MONTH')) return 'MONTHLY';
  if (has('WEEK')) return 'WEEKLY';
  return null;
}

/**
 * Suggest one of the nine Books rev-rec methods from the model's timing/pattern
 * signals and the billing kind. Deterministic and conservative: the pattern is the
 * primary signal; when it's unknown we fall back to billing kind, then timing, and
 * finally AS_BILLED (billing == recognition — the safest default that never
 * over-recognizes ahead of a bill).
 */
export function suggestRevRecMethod(
  signals: { pattern: RevRecPattern; timing: RevRecTiming; billingKind: BillingKind },
): RevRecMethod {
  const { pattern, timing, billingKind } = signals;

  switch (pattern) {
    case 'PCT_COMPLETE': return 'PCT_COMPLETE';
    case 'PCT_COSTS_INCURRED': return 'PCT_COSTS_INCURRED';
    case 'MILESTONE': return 'MILESTONE';
    case 'COMPLETED_CONTRACT': return 'COMPLETED_CONTRACT';
    case 'AS_BILLED': return 'AS_BILLED';
    case 'POINT_IN_TIME': return 'POINT_OF_SALE';
    case 'CASH': return 'CASH';
    case 'STRAIGHT_LINE':
      // Ratable recognition over the term: a recurring subscription bills and
      // recognizes ratably as SUBSCRIPTION; a one-shot prepaid term is RATABLY.
      return billingKind === 'RECURRING' ? 'SUBSCRIPTION' : 'RATABLY';
    case 'UNKNOWN':
    default:
      break;
  }

  // Pattern unknown — fall back to billing kind, then timing.
  if (billingKind === 'MILESTONE') return 'MILESTONE';
  if (billingKind === 'RECURRING') return 'SUBSCRIPTION';
  if (timing === 'POINT_IN_TIME') return 'POINT_OF_SALE';
  if (timing === 'OVER_TIME') return 'RATABLY';
  return 'AS_BILLED';
}

/** Methods where issuing the bill IS the recognition event (credit Revenue, not 2410). */
export function recognizesAtBilling(method: RevRecMethod): boolean {
  return method === 'POINT_OF_SALE' || method === 'AS_BILLED';
}

function toStringOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s === '' ? null : s;
}

/** Whole dollars (number or numeric string, tolerant of $ and commas) → number, or null. */
function toDollarsOrNull(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[$,\s]/g, '');
    if (cleaned === '') return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Whole dollars → bigint cents, or null. Rounds to the nearest cent. */
function toCentsOrNull(raw: unknown): number | null {
  const d = toDollarsOrNull(raw);
  return d === null ? null : Math.round(d * 100);
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
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return s;
}

function toIntOrNull(raw: unknown): number | null {
  const d = toDollarsOrNull(raw);
  if (d === null) return null;
  const n = Math.round(d);
  return Number.isFinite(n) ? n : null;
}

function conf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function mapBillingKind(raw: unknown, hasMilestones: boolean, hasRecurring: boolean): BillingKind {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (s.includes('MILESTONE') || s.includes('PROGRESS')) return 'MILESTONE';
  if (s.includes('RECUR') || s.includes('SUBSCRIP') || s.includes('RETAINER')) return 'RECURRING';
  if (s.includes('ONE') || s.includes('FIXED') || s.includes('LUMP')) return 'ONE_TIME';
  // No explicit kind — infer from the extracted structure.
  if (hasMilestones) return 'MILESTONE';
  if (hasRecurring) return 'RECURRING';
  return 'ONE_TIME';
}

function mapTiming(raw: unknown): RevRecTiming {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase().replace(/[^A-Z]/g, '') : '';
  if (s.includes('POINT')) return 'POINT_IN_TIME';
  if (s.includes('OVER') || s.includes('TIME')) return 'OVER_TIME';
  return 'UNKNOWN';
}

function mapPattern(raw: unknown): RevRecPattern {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase().replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!s) return 'UNKNOWN';
  const has = (...n: string[]) => n.some((x) => s.includes(x));
  if (has('COST INCURRED', 'COSTS INCURRED', 'COST TO COST', 'PCT COSTS')) return 'PCT_COSTS_INCURRED';
  if (has('PERCENT COMPLETE', 'PCT COMPLETE', 'PERCENTAGE OF COMPLETION', 'POC')) return 'PCT_COMPLETE';
  if (has('MILESTONE')) return 'MILESTONE';
  if (has('COMPLETED CONTRACT', 'ON COMPLETION', 'AT COMPLETION')) return 'COMPLETED_CONTRACT';
  if (has('STRAIGHT LINE', 'RATABLE', 'RATABLY', 'PRO RATA', 'OVER THE TERM', 'OVER TERM')) return 'STRAIGHT_LINE';
  if (has('AS BILLED', 'AS INVOICED', 'RIGHT TO INVOICE')) return 'AS_BILLED';
  if (has('POINT OF SALE', 'ON DELIVERY', 'UPON DELIVERY', 'POINT IN TIME', 'ON SHIPMENT')) return 'POINT_IN_TIME';
  if (has('CASH BASIS', 'WHEN COLLECTED', 'ON RECEIPT OF CASH')) return 'CASH';
  return 'UNKNOWN';
}

interface RawLine {
  description?: unknown;
  quantity?: unknown;
  unit_amount?: unknown;
  amount?: unknown;
}

function normalizeLine(raw: RawLine): ProposedLineItem | null {
  const description = toStringOrNull(raw.description) ?? '';
  const qtyRaw = toDollarsOrNull(raw.quantity);
  const quantity = qtyRaw !== null && qtyRaw > 0 ? qtyRaw : 1;
  const unit = toCentsOrNull(raw.unit_amount);
  const total = toCentsOrNull(raw.amount);

  let unit_price_cents: number;
  let amount_cents: number;
  if (unit !== null) {
    unit_price_cents = unit;
    amount_cents = total !== null ? total : Math.round(quantity * unit);
  } else if (total !== null) {
    amount_cents = total;
    unit_price_cents = quantity > 0 ? Math.round(total / quantity) : total;
  } else {
    return null; // no money at all — drop
  }
  if (!description && amount_cents === 0) return null;
  return { description: description || 'Contract charge', quantity, unit_price_cents, amount_cents };
}

interface RawMilestone {
  name?: unknown;
  description?: unknown;
  due_date?: unknown;
  amount?: unknown;
}

function normalizeMilestone(raw: RawMilestone): ProposedMilestone | null {
  const amount_cents = toCentsOrNull(raw.amount);
  if (amount_cents === null) return null;
  return {
    name: toStringOrNull(raw.name) ?? 'Milestone',
    description: toStringOrNull(raw.description),
    due_date: toIsoDate(raw.due_date),
    amount_cents,
  };
}

/**
 * Pure normalizer: turn the model's loose JSON into a validated NormalizedContract.
 * Infers the billing kind, maps the cadence, suggests a rev-rec method, converts all
 * money to bigint cents, leaves undeterminable fields blank, and flags low-confidence
 * / blank-but-needed fields. Never throws — a malformed shape yields a safe ONE_TIME
 * skeleton with everything flagged.
 */
export function normalizeContractExtraction(raw: unknown): NormalizedContract {
  const root = (raw && typeof raw === 'object' ? raw : {}) as {
    customer?: { name?: unknown; email?: unknown };
    contract_title?: unknown;
    total_contract_value?: unknown;
    currency?: unknown;
    start_date?: unknown;
    end_date?: unknown;
    billing_kind?: unknown;
    line_items?: unknown;
    milestones?: unknown;
    recurring?: {
      cadence?: unknown;
      interval_count?: unknown;
      amount?: unknown;
      start_date?: unknown;
      end_date?: unknown;
      occurrences?: unknown;
    };
    rev_rec?: { timing?: unknown; pattern?: unknown; reasoning?: unknown };
    confidence?: unknown;
  };

  const cust = root.customer ?? {};
  const customerName = toStringOrNull(cust.name);
  const customer: ProposedCustomer = {
    name: customerName,
    email: toStringOrNull(cust.email),
    matchKey: normalizeCustomerName(customerName),
  };

  const line_items = (Array.isArray(root.line_items) ? (root.line_items as RawLine[]) : [])
    .map((l) => (l && typeof l === 'object' ? normalizeLine(l) : null))
    .filter((l): l is ProposedLineItem => l !== null);

  const milestones = (Array.isArray(root.milestones) ? (root.milestones as RawMilestone[]) : [])
    .map((m) => (m && typeof m === 'object' ? normalizeMilestone(m) : null))
    .filter((m): m is ProposedMilestone => m !== null);

  // Recurring block (present when the contract bills on a cadence).
  const rec = root.recurring ?? null;
  const recCadence = rec ? mapCadence(rec.cadence) : null;
  const hasRecurring = recCadence !== null;

  const billing_kind = mapBillingKind(root.billing_kind, milestones.length > 0, hasRecurring);

  let recurring: ProposedRecurring | null = null;
  if (billing_kind === 'RECURRING' && rec) {
    const intervalRaw = toIntOrNull(rec.interval_count);
    const interval_count = intervalRaw !== null && intervalRaw >= 1 ? intervalRaw : 1;
    const occurrences = (() => {
      const o = toIntOrNull(rec.occurrences);
      return o !== null && o > 0 ? o : null;
    })();
    // Per-period amount: explicit, else derive from total / occurrences, else the
    // sum of the default line items.
    let amount_cents = toCentsOrNull(rec.amount);
    const totalCentsForDerive = toCentsOrNull(root.total_contract_value);
    if (amount_cents === null && totalCentsForDerive !== null && occurrences && occurrences > 0) {
      amount_cents = Math.round(totalCentsForDerive / occurrences);
    }
    if (amount_cents === null && line_items.length > 0) {
      amount_cents = line_items.reduce((s, l) => s + l.amount_cents, 0);
    }
    recurring = {
      cadence: recCadence ?? 'MONTHLY',
      interval_count,
      amount_cents: amount_cents ?? 0,
      start_date: toIsoDate(rec.start_date) ?? toIsoDate(root.start_date),
      end_date: toIsoDate(rec.end_date) ?? toIsoDate(root.end_date),
      occurrences,
    };
  }

  // Total contract value: explicit, else derived from the parts.
  let total_contract_value_cents = toCentsOrNull(root.total_contract_value);
  if (total_contract_value_cents === null) {
    if (milestones.length > 0) {
      total_contract_value_cents = milestones.reduce((s, m) => s + m.amount_cents, 0);
    } else if (billing_kind === 'RECURRING' && recurring && recurring.occurrences) {
      total_contract_value_cents = recurring.amount_cents * recurring.occurrences;
    } else if (line_items.length > 0) {
      total_contract_value_cents = line_items.reduce((s, l) => s + l.amount_cents, 0);
    }
  }

  // Rev-rec suggestion.
  const rr = root.rev_rec ?? {};
  const timing = mapTiming(rr.timing);
  const pattern = mapPattern(rr.pattern);
  const method = suggestRevRecMethod({ pattern, timing, billingKind: billing_kind });
  const rev_rec: RevRecSuggestion = {
    method,
    timing,
    pattern,
    recognizesAtBilling: recognizesAtBilling(method),
    reasoning: toStringOrNull(rr.reasoning),
    confidence: conf((root.confidence as Record<string, unknown> | undefined)?.rev_rec),
  };

  const c = (root.confidence ?? {}) as Record<string, unknown>;
  const confidence: Record<string, number> = {
    customer: conf(c.customer),
    total_contract_value: conf(c.total_contract_value),
    dates: conf(c.dates),
    billing_kind: conf(c.billing_kind),
    schedule: conf(c.schedule),
    rev_rec: conf(c.rev_rec),
  };

  // Flag blank-but-needed and low-confidence fields for the reviewer.
  const low: string[] = [];
  if (!customer.name) low.push('customer');
  else if (confidence.customer < LOW_CONFIDENCE) low.push('customer');
  if (total_contract_value_cents === null || total_contract_value_cents === 0) low.push('total_contract_value');
  else if (confidence.total_contract_value < LOW_CONFIDENCE) low.push('total_contract_value');

  if (billing_kind === 'RECURRING') {
    if (!recurring || recurring.amount_cents === 0) low.push('recurring_amount');
    if (!recurring || !recurring.start_date) low.push('start_date');
  } else if (billing_kind === 'MILESTONE') {
    if (milestones.length === 0) low.push('milestones');
  } else {
    if (line_items.length === 0) low.push('line_items');
  }
  if (rev_rec.confidence < LOW_CONFIDENCE || pattern === 'UNKNOWN') low.push('rev_rec');

  return {
    customer,
    contract_title: toStringOrNull(root.contract_title),
    total_contract_value_cents,
    start_date: toIsoDate(root.start_date),
    end_date: toIsoDate(root.end_date),
    currency: toStringOrNull(root.currency),
    billing_kind,
    line_items,
    milestones: billing_kind === 'MILESTONE' ? milestones : [],
    recurring,
    rev_rec,
    confidence,
    lowConfidenceFields: Array.from(new Set(low)),
    notes: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway call
// ─────────────────────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are an expert revenue/billing accountant. Read this signed customer contract or Statement of Work (SOW) and extract the BILLING TERMS so an invoice or billing schedule can be proposed.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "customer": {
    "name": "string or null — the CUSTOMER/CLIENT being billed (not the vendor/service provider issuing the contract)",
    "email": "string or null — a billing contact email if present"
  },
  "contract_title": "string or null — the agreement title (e.g. 'Master Services Agreement', 'SOW #4 — Website Rebuild')",
  "total_contract_value": number or null — total contract value in WHOLE DOLLARS (not cents). null if not stated,
  "currency": "string or null — e.g. USD",
  "start_date": "YYYY-MM-DD or null — service/term start",
  "end_date": "YYYY-MM-DD or null — service/term end",
  "billing_kind": "ONE_TIME | MILESTONE | RECURRING — how the customer is billed. ONE_TIME = single fixed fee; MILESTONE = payments tied to deliverables/phases; RECURRING = repeats on a cadence (monthly retainer, subscription)",
  "line_items": [
    { "description": "string", "quantity": number or null, "unit_amount": number or null (WHOLE DOLLARS), "amount": number or null (WHOLE DOLLARS, line total) }
  ],
  "milestones": [
    { "name": "string", "description": "string or null", "due_date": "YYYY-MM-DD or null", "amount": number (WHOLE DOLLARS) }
  ],
  "recurring": {
    "cadence": "WEEKLY | BIWEEKLY | MONTHLY | QUARTERLY | SEMIANNUAL | ANNUAL or null",
    "interval_count": number or null (e.g. 1 = every period, 2 = every other),
    "amount": number or null — amount billed EACH period, WHOLE DOLLARS,
    "start_date": "YYYY-MM-DD or null",
    "end_date": "YYYY-MM-DD or null",
    "occurrences": number or null — total number of periods if finite
  },
  "rev_rec": {
    "timing": "POINT_IN_TIME | OVER_TIME | UNKNOWN — is revenue earned at a moment (delivery/sale) or continuously over the term?",
    "pattern": "PCT_COMPLETE | PCT_COSTS_INCURRED | STRAIGHT_LINE | MILESTONE | COMPLETED_CONTRACT | AS_BILLED | POINT_IN_TIME | CASH | UNKNOWN — how should revenue be recognized?",
    "reasoning": "string or null — one sentence citing the contract language that drives the timing/pattern"
  },
  "confidence": {
    "customer": number 0-1, "total_contract_value": number 0-1, "dates": number 0-1,
    "billing_kind": number 0-1, "schedule": number 0-1, "rev_rec": number 0-1
  },
  "document_note": "string or null — anything unusual (scanned/illegible, draft/unsigned, amendment, ambiguous terms)"
}

Rules:
- Only fill "milestones" when billing_kind is MILESTONE; only fill "recurring" when billing_kind is RECURRING; otherwise use "line_items".
- The AMOUNTS ARE IN WHOLE DOLLARS, never cents. Ratios/quantities as plain numbers.
- If a field is NOT stated in the contract, use null and set its confidence to 0. NEVER invent a value.
- rev_rec.pattern guidance: a monthly retainer/subscription over a term => STRAIGHT_LINE (over time); a construction/SOW with % completion => PCT_COMPLETE or PCT_COSTS_INCURRED; deliverable-based payments => MILESTONE; a product delivered once => POINT_IN_TIME; a pure time-and-materials "bill as you go" => AS_BILLED.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded contract / SOW into a normalized billing proposal THROUGH the
 * Core AI gateway (metered, budget-capped per tenant; `orgId` scopes it, `userId`
 * attributes it). Accepts base64-encoded PDF or image. Never throws for the expected
 * failure cases — returns `{ ok: false, ... }` so callers degrade cleanly.
 */
export async function parseContractDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParseContractResult> {
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
        feature: CONTRACT_EXTRACT_FEATURE,
        model: CONTRACT_EXTRACT_MODEL,
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
    console.error('[contract-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const contract = normalizeContractExtraction(parsed);
  const documentNote =
    parsed && typeof parsed === 'object'
      ? toStringOrNull((parsed as { document_note?: unknown }).document_note)
      : null;
  contract.notes = documentNote;

  return {
    ok: true,
    contract,
    model: gw.model_used ?? CONTRACT_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
    documentNote,
  };
}
