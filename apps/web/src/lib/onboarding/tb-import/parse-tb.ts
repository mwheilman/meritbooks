/**
 * Trial-balance parser — DROP-AND-PARSE opening-balance import.
 *
 * Takes an uploaded PRIOR-SYSTEM trial balance (a PDF or an image of a QuickBooks /
 * Sage / Xero TB → base64) and, THROUGH the Core AI gateway (`@meritbooks/core-ai`,
 * feature TRIAL_BALANCE_EXTRACT, metered to core.ai_usage_log, tenant budget enforced
 * across the combined suite), extracts every account line with its debit/credit
 * balance. The result is shaped so the caller can feed it straight into the EXISTING
 * historical-conversion path (`POST /api/onboarding/conversion`), which already does
 * the source→COA mapping, the tie-out gate, and the balanced OPENING_BALANCE posting.
 * This module does NO GL posting of its own.
 *
 * Canon boundary (§3): the AI PROPOSES facts — it never writes a ledger entry and
 * never authors a balance beyond reading it off the document. The model returns JSON
 * that is validated + normalized by the PURE `normalizeTrialBalance` here (no gateway
 * dependency, unit-tested), the tie-out (debits == credits) is computed in CENTS (never
 * floats, via `dollarsToCents`), and a human reviews/confirms every line downstream.
 * Anything the model can't determine is left blank — never guessed.
 *
 * The model call lives in `parseTrialBalance`; the deterministic pieces
 * (`normalizeTrialBalance`, `isNonAccountRow`) are exported separately for tests.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { dollarsToCents } from '@meritbooks/shared';

export const TRIAL_BALANCE_EXTRACT_FEATURE = 'TRIAL_BALANCE_EXTRACT';
export const TRIAL_BALANCE_EXTRACT_MODEL = 'claude-sonnet-4-6';

const LOW_CONFIDENCE = 0.6;

/** One proposed trial-balance line, in WHOLE DOLLARS as read plus its cents echo. */
export interface TrialBalanceLine {
  /** Deterministic local id for the review UI (stable across a given extraction). */
  _id: string;
  /** The account number/code exactly as printed, or null when the TB omits codes. */
  account_number: string | null;
  /** The account name as printed (always present — a line with neither is dropped). */
  account_name: string;
  /** Debit balance in WHOLE DOLLARS (positive magnitude), or null when not a debit. */
  debit: number | null;
  /** Credit balance in WHOLE DOLLARS (positive magnitude), or null when not a credit. */
  credit: number | null;
  /** Debit balance in CENTS (0 when null) — the authoritative money value. */
  debitCents: number;
  /** Credit balance in CENTS (0 when null). */
  creditCents: number;
  /** Model confidence for this line, 0..1. */
  confidence: number;
  /** True when the line is low-confidence or missing a required field (flag for review). */
  lowConfidence: boolean;
  /** Verbatim excerpt of the source line, for traceability. */
  snippet: string | null;
}

/** The pure, validated result of normalizing the model's loose JSON. No gateway. */
export interface NormalizedTrialBalance {
  lines: TrialBalanceLine[];
  totalDebitCents: number;
  totalCreditCents: number;
  /** debits − credits, in cents; zero when the TB ties out. */
  differenceCents: number;
  /** True only when total debits == total credits (the tie-out check). */
  balanced: boolean;
  /** Rows the parser set aside as non-account (headers/totals/blank), never silently. */
  dropped: { snippet: string; reason: string }[];
  documentNote: string | null;
}

export type ParseTrialBalanceResult =
  | ({
      ok: true;
      model: string;
      correlationId: string | null;
      extractionMs: number;
    } & NormalizedTrialBalance)
  | { ok: false; error: string; budgetBlocked?: boolean };

// ─────────────────────────────────────────────────────────────────────────────
// Coercion helpers (pure, total)
// ─────────────────────────────────────────────────────────────────────────────

function toStringOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s === '' ? null : s;
}

/**
 * Parse a money figure to a SIGNED dollar number, or null. Handles number input,
 * "$1,234.56", "(45.00)" (accounting negative), and "-12.30". Returns dollars (not
 * cents) so the caller can echo the source magnitude; cents are derived downstream.
 */
function toDollarsOrNull(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s === '') return null;
  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    negative = true;
    s = paren[1];
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  const cleaned = s.replace(/[$,\s]/g, '');
  if (cleaned === '' || !/^\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function conf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Names that are summary/section labels, not real accounts (checked when no code). */
const TOTAL_LABELS: ReadonlySet<string> = new Set([
  'total',
  'totals',
  'subtotal',
  'sub total',
  'grand total',
  'total debits',
  'total credits',
  'total debit',
  'total credit',
  'total assets',
  'total liabilities',
  'total equity',
  'total revenue',
  'total income',
  'total expenses',
  'total liabilities and equity',
  'net income',
  'net loss',
  'net income loss',
  'trial balance',
  'balance',
]);

interface RawTbLine {
  account_number?: unknown;
  account_code?: unknown;
  account?: unknown;
  account_name?: unknown;
  name?: unknown;
  debit?: unknown;
  credit?: unknown;
  snippet?: unknown;
  confidence?: unknown;
}

/**
 * Decide whether a raw line is a NON-account row (a header, a totals/subtotal line, or
 * blank) that must be excluded from the opening balance. Returns a reason when dropped,
 * or null to keep. Exported for direct unit testing.
 *
 *   - No name AND no code AND no amount ⇒ blank/noise.
 *   - A single label (e.g. "Total Assets", "Net Income") with no account code ⇒ summary.
 *   - Both a debit AND a credit populated on one line ⇒ a totals/summary row (a real TB
 *     line is a debit XOR a credit) — mirrors the conversion route's own exclusion.
 */
export function isNonAccountRow(args: {
  accountNumber: string | null;
  accountName: string | null;
  debitDollars: number | null;
  creditDollars: number | null;
}): string | null {
  const { accountNumber, accountName, debitDollars, creditDollars } = args;
  const hasDebit = debitDollars != null && debitDollars !== 0;
  const hasCredit = creditDollars != null && creditDollars !== 0;

  if (!accountName && !accountNumber && !hasDebit && !hasCredit) {
    return 'Blank row — no account, no balance.';
  }
  if (hasDebit && hasCredit) {
    return 'Row carries both a debit and a credit — excluded as a subtotal/total row.';
  }
  if (!accountNumber && accountName) {
    const norm = accountName.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (TOTAL_LABELS.has(norm)) {
      return `Summary label "${accountName}" with no account code — excluded as a total/header row.`;
    }
  }
  if (!accountName && !accountNumber) {
    return 'Row has no account name or code — excluded.';
  }
  return null;
}

/**
 * Pure normalizer: turn the model's loose JSON into a validated NormalizedTrialBalance.
 * Reads each line's debit/credit as positive magnitudes (folding an accounting-style
 * negative onto the opposite column, exactly as the downstream conversion route does),
 * DROPS non-account rows (headers/totals/blank, reported in `dropped` — never silently),
 * and computes the tie-out (debits == credits) in CENTS via `dollarsToCents`. Never
 * throws — a malformed shape yields an empty, balanced (0 == 0) result.
 */
export function normalizeTrialBalance(raw: unknown): NormalizedTrialBalance {
  const root = (raw ?? {}) as { lines?: unknown; rows?: unknown; accounts?: unknown; document_note?: unknown };
  const listSource = root.lines ?? root.rows ?? root.accounts;
  const list = Array.isArray(listSource) ? (listSource as RawTbLine[]) : [];

  const lines: TrialBalanceLine[] = [];
  const dropped: { snippet: string; reason: string }[] = [];
  let totalDebitCents = 0;
  let totalCreditCents = 0;

  list.forEach((rt, index) => {
    if (rt == null || typeof rt !== 'object') return;

    const account_number = toStringOrNull(rt.account_number) ?? toStringOrNull(rt.account_code) ?? toStringOrNull(rt.account);
    const account_name = toStringOrNull(rt.account_name) ?? toStringOrNull(rt.name);
    const snippet = toStringOrNull(rt.snippet);

    // Read both columns as signed dollars, then fold negatives onto the opposite side so
    // every retained line is a debit XOR a credit (positive magnitudes).
    let debitDollars = toDollarsOrNull(rt.debit);
    let creditDollars = toDollarsOrNull(rt.credit);
    if (debitDollars != null && debitDollars < 0) {
      creditDollars = (creditDollars ?? 0) + -debitDollars;
      debitDollars = null;
    }
    if (creditDollars != null && creditDollars < 0) {
      debitDollars = (debitDollars ?? 0) + -creditDollars;
      creditDollars = null;
    }

    const dropReason = isNonAccountRow({ accountNumber: account_number, accountName: account_name, debitDollars, creditDollars });
    if (dropReason) {
      dropped.push({ snippet: snippet ?? account_name ?? account_number ?? `line ${index + 1}`, reason: dropReason });
      return;
    }

    const hasDebit = debitDollars != null && debitDollars !== 0;
    const hasCredit = creditDollars != null && creditDollars !== 0;
    // A zero-balance account posts nothing — set it aside (reported), like the conversion route.
    if (!hasDebit && !hasCredit) {
      dropped.push({ snippet: snippet ?? account_name ?? account_number ?? `line ${index + 1}`, reason: 'Zero balance — nothing to post.' });
      return;
    }

    const debit = hasDebit ? debitDollars : null;
    const credit = hasCredit ? creditDollars : null;
    const debitCents = debit != null ? dollarsToCents(debit) : 0;
    const creditCents = credit != null ? dollarsToCents(credit) : 0;
    totalDebitCents += debitCents;
    totalCreditCents += creditCents;

    const confidence = conf(rt.confidence);
    const lowConfidence = confidence < LOW_CONFIDENCE || account_name == null;

    lines.push({
      _id: `tb${index}`,
      account_number,
      account_name: account_name ?? '',
      debit,
      credit,
      debitCents,
      creditCents,
      confidence,
      lowConfidence,
      snippet,
    });
  });

  const differenceCents = totalDebitCents - totalCreditCents;
  return {
    lines,
    totalDebitCents,
    totalCreditCents,
    differenceCents,
    balanced: differenceCents === 0,
    dropped,
    documentNote: toStringOrNull(root.document_note),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway extraction
// ─────────────────────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are an expert bookkeeper. Read this TRIAL BALANCE (or general-ledger balances report) exported from a prior accounting system (QuickBooks, Sage, Xero, etc.) and extract EVERY account line with its ending debit or credit balance.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "lines": [
    {
      "account_number": "string or null — the account number/code exactly as printed (null if the report has no codes)",
      "account_name": "string — the account name/description exactly as printed",
      "debit": number or null — the DEBIT balance in WHOLE DOLLARS (e.g. 1234.56), or null if this account's balance is a credit,
      "credit": number or null — the CREDIT balance in WHOLE DOLLARS, or null if this account's balance is a debit,
      "confidence": number 0-1 — your confidence in this line,
      "snippet": "string — a short verbatim excerpt of this row, for traceability"
    }
  ],
  "document_note": "string or null — anything unusual (scanned/illegible, multiple periods, no account codes, totals did not foot, this is not a trial balance)"
}

Rules:
- Extract ALL account lines. Each real account line has EITHER a debit OR a credit balance — never both. Put the amount in the correct column and leave the other null.
- Amounts are POSITIVE magnitudes in whole dollars-and-cents. Do NOT include currency symbols or thousands separators in the numbers.
- DO NOT include summary/total rows (e.g. 'Total', 'Total Assets', 'Total Debits', 'Net Income', 'TOTAL') as account lines — those are the report's footings, not accounts.
- DO NOT include section headers (e.g. 'ASSETS', 'LIABILITIES', 'REVENUE') as account lines.
- If the report shows a single signed balance column instead of separate debit/credit columns: a POSITIVE balance is a debit, a NEGATIVE balance is a credit — split it accordingly.
- If a field is not stated, use null — NEVER invent a value.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded trial balance into normalized proposed lines THROUGH the Core AI
 * gateway (metered, budget-capped per tenant; `orgId` scopes it, `userId` attributes
 * it). Accepts base64-encoded PDF or image data. Never throws for the expected failure
 * cases — returns `{ ok: false, ... }` so callers degrade cleanly.
 */
export async function parseTrialBalance(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: { orgId: string; userId?: string | null; base64Data: string; mediaType: string },
): Promise<ParseTrialBalanceResult> {
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
        feature: TRIAL_BALANCE_EXTRACT_FEATURE,
        model: TRIAL_BALANCE_EXTRACT_MODEL,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: EXTRACTION_PROMPT }] }],
        max_tokens: 8000,
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
    console.error('[parse-tb] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const normalized = normalizeTrialBalance(parsed);

  return {
    ok: true,
    ...normalized,
    model: gw.model_used ?? TRIAL_BALANCE_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
  };
}
