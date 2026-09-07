/**
 * Universal document classifier — DROP-EVERYTHING intake triage.
 *
 * The onboarding promise is "drop everything, we sort it": a user hands the system
 * ANY document and the classifier reads the first page/portion and decides WHAT it is
 * and WHERE it should go. It does not extract the document's contents — it only routes.
 * The dedicated parser at the destination (e.g. /api/debt/parse for a LOAN) then does
 * the structured extraction. This keeps the classifier cheap, fast, and single-purpose.
 *
 * Mirrors the drop-and-parse pattern of `lib/debt/parse-loan.ts`: it runs THROUGH the
 * Core AI gateway (`@meritbooks/core-ai`, feature INTAKE_CLASSIFY, metered to
 * core.ai_usage_log with the tenant budget enforced), accepts a base64 PDF/image,
 * and asks the model for ONLY JSON. The pure `normalizeClassification` maps the loose
 * JSON to a validated result with no gateway dependency, so it is unit-testable.
 *
 * Canon boundary: the AI PROPOSES a routing decision — it writes nothing to the ledger.
 * When the model is unsure it must answer UNKNOWN rather than guess; a garbled or
 * unrecognized answer normalizes to UNKNOWN so the human is never sent down the wrong
 * pipeline on a low-quality signal.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';

export const INTAKE_CLASSIFY_FEATURE = 'INTAKE_CLASSIFY';
export const INTAKE_CLASSIFY_MODEL = 'claude-sonnet-4-6';

/** The canonical document types the intake classifier can recognize. */
export type IntakeDocType =
  | 'LOAN'
  | 'LEASE'
  | 'BILL'
  | 'BANK_STATEMENT'
  | 'TRIAL_BALANCE'
  | 'W9'
  | 'COI'
  | 'CUSTOMER_CONTRACT'
  | 'OPERATING_AGREEMENT'
  | 'INSURANCE_POLICY'
  | 'PREPAID'
  | 'SUBSCRIPTION'
  | 'PAYROLL_REGISTER'
  | 'WIP_SCHEDULE'
  | 'FORMATION_DOC'
  | 'UNKNOWN';

/** One routing entry: the type, its human label, the destination page, and the parser (if any). */
export interface IntakeRoute {
  docType: IntakeDocType;
  label: string;
  /** The app page the document routes to. */
  route: string;
  /** The dedicated parse endpoint to hand the file to, or null when no parser exists yet. */
  parseEndpoint: string | null;
}

/**
 * The authoritative type → destination map. This is the single source of truth for where
 * every recognized document goes; the normalizer resolves route/parseEndpoint by lookup here.
 */
export const INTAKE_ROUTES: Record<IntakeDocType, IntakeRoute> = {
  LOAN: { docType: 'LOAN', label: 'Loan / Credit Agreement', route: '/debt', parseEndpoint: '/api/debt/parse' },
  LEASE: { docType: 'LEASE', label: 'Lease Agreement', route: '/leases', parseEndpoint: '/api/leases/parse' },
  BILL: { docType: 'BILL', label: 'Vendor Bill / Invoice', route: '/bills', parseEndpoint: '/api/bills/parse' },
  BANK_STATEMENT: {
    docType: 'BANK_STATEMENT',
    label: 'Bank Statement',
    route: '/bank-feed',
    parseEndpoint: '/api/bank-feed/import-statement',
  },
  TRIAL_BALANCE: {
    docType: 'TRIAL_BALANCE',
    label: 'Trial Balance',
    route: '/onboarding',
    parseEndpoint: '/api/onboarding/import/tb',
  },
  W9: { docType: 'W9', label: 'Form W-9', route: '/vendors', parseEndpoint: '/api/vendors/w9-parse' },
  COI: {
    docType: 'COI',
    label: 'Certificate of Insurance',
    route: '/vendor-compliance',
    parseEndpoint: '/api/vendors/coi-parse',
  },
  CUSTOMER_CONTRACT: {
    docType: 'CUSTOMER_CONTRACT',
    label: 'Customer Contract',
    route: '/invoices',
    parseEndpoint: '/api/invoices/parse-contract',
  },
  OPERATING_AGREEMENT: {
    docType: 'OPERATING_AGREEMENT',
    label: 'Operating Agreement',
    route: '/onboarding',
    parseEndpoint: '/api/onboarding/import/equity',
  },
  INSURANCE_POLICY: {
    docType: 'INSURANCE_POLICY',
    label: 'Insurance Policy',
    route: '/insurance',
    parseEndpoint: '/api/insurance/parse',
  },
  PREPAID: { docType: 'PREPAID', label: 'Prepaid Expense Document', route: '/prepaids', parseEndpoint: '/api/prepaid/parse' },
  SUBSCRIPTION: {
    docType: 'SUBSCRIPTION',
    label: 'Subscription Agreement',
    route: '/subscriptions',
    parseEndpoint: '/api/subscriptions/parse-agreement',
  },
  PAYROLL_REGISTER: {
    docType: 'PAYROLL_REGISTER',
    label: 'Payroll Register',
    route: '/payroll',
    parseEndpoint: '/api/payroll/import-register',
  },
  WIP_SCHEDULE: {
    docType: 'WIP_SCHEDULE',
    label: 'WIP Schedule',
    route: '/jobs',
    parseEndpoint: '/api/onboarding/import/wip',
  },
  FORMATION_DOC: {
    docType: 'FORMATION_DOC',
    label: 'Formation Document',
    route: '/onboarding',
    // No parser yet — Wave 3. The file still routes to onboarding for manual handling.
    parseEndpoint: null,
  },
  UNKNOWN: { docType: 'UNKNOWN', label: 'Unrecognized Document', route: '/onboarding', parseEndpoint: null },
};

/** The successful classification handed back to the caller / UI. */
export interface ClassificationSuccess {
  ok: true;
  docType: IntakeDocType;
  label: string;
  /** Model confidence in the routing decision, clamped to 0-1. */
  confidence: number;
  route: string;
  parseEndpoint: string | null;
  /** A short human-readable rationale / observation from the model (never null; '' when absent). */
  note: string;
}

export interface ClassificationFailure {
  ok: false;
  error: string;
}

export type ClassificationResult = ClassificationSuccess | ClassificationFailure;

/** Set of all valid docType strings, for O(1) membership checks against loose input. */
const DOC_TYPES: ReadonlySet<string> = new Set(Object.keys(INTAKE_ROUTES));

function clampConfidence(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function toTrimmedString(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

/**
 * Coerce a loose model docType string to a canonical IntakeDocType. Uppercases,
 * strips non-letters (so "bank-statement", "bank statement", "Bank_Statement" all
 * normalize), and only accepts an exact match against the known set — anything else
 * (empty, garbled, hallucinated) falls to UNKNOWN.
 */
export function mapDocType(raw: unknown): IntakeDocType {
  if (typeof raw !== 'string') return 'UNKNOWN';
  const normalized = raw.trim().toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z0-9_]/g, '');
  if (DOC_TYPES.has(normalized)) return normalized as IntakeDocType;
  return 'UNKNOWN';
}

interface RawClassification {
  doc_type?: unknown;
  docType?: unknown;
  type?: unknown;
  confidence?: unknown;
  note?: unknown;
  reasoning?: unknown;
}

/**
 * Pure normalizer: map the model's loose JSON to a validated ClassificationSuccess.
 * Resolves route/parseEndpoint from INTAKE_ROUTES by docType lookup; an unknown or
 * garbled docType becomes UNKNOWN (routed to onboarding, no parser). Never throws.
 *
 * A low-confidence answer for a recognized type is downgraded to UNKNOWN so the human
 * is not sent down a specific parser on a weak signal — the "answer UNKNOWN when unsure"
 * rule is enforced on our side too, not only in the prompt.
 */
export function normalizeClassification(raw: unknown): ClassificationSuccess {
  const root = (raw ?? {}) as RawClassification;

  let docType = mapDocType(root.doc_type ?? root.docType ?? root.type);
  const confidence = clampConfidence(root.confidence);

  // Enforce the "unsure → UNKNOWN" contract on our side: a recognized type with a weak
  // signal is not trustworthy enough to route to a specific parser.
  const LOW_CONFIDENCE = 0.4;
  if (docType !== 'UNKNOWN' && confidence < LOW_CONFIDENCE) {
    docType = 'UNKNOWN';
  }

  const route = INTAKE_ROUTES[docType];
  const note = toTrimmedString(root.note ?? root.reasoning);

  return {
    ok: true,
    docType: route.docType,
    label: route.label,
    confidence,
    route: route.route,
    parseEndpoint: route.parseEndpoint,
    note,
  };
}

const CLASSIFY_PROMPT = `You are a document intake triage specialist for an accounting book-of-record system. A user has dropped a document during onboarding. Read only the FIRST page / opening portion — enough to identify WHAT KIND of document this is. Do NOT extract its detailed contents; a dedicated parser will do that later. Your ONLY job is to classify it into exactly one type.

The allowed types (choose the single best fit):
- LOAN — a loan agreement, promissory note, credit agreement, line of credit, or debt instrument.
- LEASE — a lease agreement for real estate or equipment (lessor/lessee, rent, term).
- BILL — a vendor bill or accounts-payable invoice the business RECEIVED and must pay.
- BANK_STATEMENT — a bank or credit-card account statement (transactions, beginning/ending balance).
- TRIAL_BALANCE — a trial balance or general-ledger balances export (accounts with debit/credit columns).
- W9 — an IRS Form W-9 (Request for Taxpayer Identification Number).
- COI — a Certificate of Insurance (ACORD form; evidence of a vendor's coverage).
- CUSTOMER_CONTRACT — a signed customer / sales agreement, MSA, or SOW under which the business will bill a customer.
- OPERATING_AGREEMENT — an LLC operating agreement or partnership agreement (members, ownership, capital).
- INSURANCE_POLICY — the business's OWN insurance policy document (declarations page, coverages, premium).
- PREPAID — a document evidencing a prepaid expense (annual prepayment, retainer, prepaid maintenance).
- SUBSCRIPTION — a SaaS / software / recurring subscription agreement or order form.
- PAYROLL_REGISTER — a payroll register or payroll summary (employees, gross/net pay, taxes).
- WIP_SCHEDULE — a work-in-progress / construction job-cost schedule (contracts, costs, % complete, billings).
- FORMATION_DOC — a company formation document (articles of incorporation/organization, certificate of formation).
- UNKNOWN — none of the above, or you cannot tell with reasonable confidence.

Return ONLY valid JSON (no markdown, no prose, no code fences) with this exact shape:
{
  "doc_type": "one of the types above, verbatim",
  "confidence": number between 0 and 1 — how sure you are of the type,
  "note": "one short sentence: what you saw that led to this classification, or why you're unsure"
}

Rules:
- Choose exactly ONE type. If two seem to fit, pick the more specific one that determines where the document should be processed.
- If you are NOT confident, answer "UNKNOWN" with a low confidence rather than GUESSING a specific type. A wrong specific answer sends the user down the wrong pipeline — UNKNOWN is the safe default.
- Base the decision only on what the document actually shows. Do not invent a type that isn't supported by the page.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

export type ClassifyDocumentResult =
  | {
      ok: true;
      classification: ClassificationSuccess;
      model: string;
      correlationId: string | null;
      classifyMs: number;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

/**
 * Classify an uploaded document THROUGH the Core AI gateway (metered, budget-capped
 * per tenant; `orgId` scopes it, `userId` attributes it). Accepts a base64-encoded PDF
 * or image. Never throws for expected failure cases — returns `{ ok: false, ... }` so
 * callers degrade cleanly.
 */
export async function classifyDocument(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ClassifyDocumentResult> {
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
        feature: INTAKE_CLASSIFY_FEATURE,
        model: INTAKE_CLASSIFY_MODEL,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: CLASSIFY_PROMPT }] }],
        max_tokens: 500,
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
    console.error('[intake-classify] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const classification = normalizeClassification(parsed);

  return {
    ok: true,
    classification,
    model: gw.model_used ?? INTAKE_CLASSIFY_MODEL,
    correlationId: gw.correlation_id ?? null,
    classifyMs: Date.now() - startTime,
  };
}
