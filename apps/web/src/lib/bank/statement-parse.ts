/**
 * Bank / credit-card statement parser — DROP-AND-PARSE statement import.
 *
 * Takes an uploaded bank or credit-card statement (PDF or image → base64) and,
 * THROUGH the Core AI gateway (`@meritbooks/core-ai`, feature STATEMENT_EXTRACT,
 * metered to core.ai_usage_log, tenant budget enforced across the combined suite),
 * extracts a STRUCTURED statement: the account (last-4 / name — used to match an
 * existing manual bank account), the statement period, the opening/closing balance,
 * and every transaction line (date, description, signed amount, running balance if
 * present). Everything is normalized to the `bank_transactions` shape (bigint cents).
 *
 * Canon boundary (§2/§3): the AI PROPOSES facts — it never writes a bank line and
 * never touches the ledger. The model returns JSON that is validated + normalized by
 * the PURE `normalizeStatementExtraction` here; the human reviews/edits/confirms every
 * line in the UI, and only the confirmed rows persist via the import-statement confirm
 * route into the EXISTING categorize/reconcile pipeline (status='PENDING'). Anything the
 * model can't determine is left blank — never guessed.
 *
 * Sign convention mirrors `bank_transactions.amount_cents`: NEGATIVE = money out (a
 * debit to the account / a card charge), POSITIVE = money in (a deposit / a card
 * payment or credit). For a CREDIT_CARD / LINE_OF_CREDIT statement the charges are
 * LIABILITY-SIDE — a charge increases the amount owed — so the balance tie-out inverts
 * the sign (see `computeBalanceTie` / `signFactorForType`).
 *
 * The model call lives in `parseBankStatement`; the pure, deterministic pieces
 * (`normalizeStatementExtraction`, `computeBalanceTie`, `dedupeKey`,
 * `mapStatementAccountType`) are exported separately and unit-tested with no gateway
 * dependency.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { dollarsToCents } from '@meritbooks/shared';

export const STATEMENT_EXTRACT_FEATURE = 'STATEMENT_EXTRACT';
export const STATEMENT_EXTRACT_MODEL = 'claude-sonnet-4-20250514';

/** Bank-account types the target account can have (migration 005 CHECK). */
export const STATEMENT_ACCOUNT_TYPES = ['CHECKING', 'SAVINGS', 'CREDIT_CARD', 'LINE_OF_CREDIT'] as const;
export type StatementAccountType = (typeof STATEMENT_ACCOUNT_TYPES)[number];

/** Liability-side account types — their statement "balance" is an amount OWED. */
const LIABILITY_TYPES: ReadonlySet<StatementAccountType> = new Set(['CREDIT_CARD', 'LINE_OF_CREDIT']);

/** Source marker written to `bank_transactions.category` on confirm (see route). */
export const STATEMENT_IMPORT_SOURCE = 'STATEMENT_IMPORT';

export type TxnDirection = 'money_in' | 'money_out';

/** One proposed statement transaction line, mapped onto the bank_transactions shape. */
export interface ProposedStatementTxn {
  /** Deterministic local id for the review UI (stable across a given extraction). */
  _id: string;
  /** ISO yyyy-mm-dd or null when the line's date was undeterminable. */
  transaction_date: string | null;
  description: string;
  /** Signed cents: NEGATIVE = money out (debit / charge), POSITIVE = money in. */
  amount_cents: number | null;
  direction: TxnDirection;
  /** Running balance after this line, in cents; null when the statement omits it. */
  running_balance_cents: number | null;
  /** Model confidence for this line, 0..1. */
  confidence: number;
  /** True when the line is low-confidence or missing a required field (flag for review). */
  lowConfidence: boolean;
}

export interface StatementBalanceTie {
  /** True only when opening AND closing balances were both extracted (else we can't check). */
  checkable: boolean;
  openingCents: number | null;
  closingCents: number | null;
  /** Sum of the proposed lines' signed amount_cents (null lines excluded). */
  sumCents: number;
  /** signFactor * (closing - opening); null when not checkable. */
  expectedSumCents: number | null;
  /** sumCents - expectedSumCents; null when not checkable. */
  differenceCents: number | null;
  /** True when |difference| <= tolerance (or not checkable — nothing to contradict). */
  tied: boolean;
  toleranceCents: number;
}

export interface NormalizedStatement {
  account: {
    name: string | null;
    /** Last 4 of the statement's account number, for matching an existing bank account. */
    last4: string | null;
    type: StatementAccountType | null;
  };
  periodStart: string | null;
  periodEnd: string | null;
  openingCents: number | null;
  closingCents: number | null;
  transactions: ProposedStatementTxn[];
  balanceTie: StatementBalanceTie;
  documentNote: string | null;
}

export type ParseStatementResult =
  | {
      ok: true;
      statement: NormalizedStatement;
      model: string;
      correlationId: string | null;
      extractionMs: number;
    }
  | { ok: false; error: string; budgetBlocked?: boolean };

const LOW_CONFIDENCE = 0.6;

/** Map free-form account-type language onto the constrained enum. Null when unknown. */
export function mapStatementAccountType(raw: unknown): StatementAccountType | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  if (!s) return null;
  if ((STATEMENT_ACCOUNT_TYPES as readonly string[]).includes(s)) return s as StatementAccountType;
  const t = s.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const has = (...needles: string[]) => needles.some((n) => t.includes(n));
  if (has('CREDIT CARD', 'CREDITCARD', 'VISA', 'MASTERCARD', 'AMEX', 'AMERICAN EXPRESS', 'CHARGE CARD'))
    return 'CREDIT_CARD';
  if (has('LINE OF CREDIT', 'LOC', 'REVOLVER', 'REVOLVING')) return 'LINE_OF_CREDIT';
  if (has('SAVING', 'MONEY MARKET')) return 'SAVINGS';
  if (has('CHECK', 'CHEQUE', 'DEMAND DEPOSIT', 'DDA', 'OPERATING')) return 'CHECKING';
  return null;
}

/**
 * Balance-tie sign factor derived MECHANICALLY from the account type:
 *   - ASSET accounts (checking/savings): closing = opening + sum(signed amounts)  => +1
 *   - LIABILITY accounts (credit card / LOC): the statement balance is an amount OWED, and a
 *     charge (money out) INCREASES it, so closing = opening - sum(signed amounts)  => -1
 */
export function signFactorForType(type: StatementAccountType): 1 | -1 {
  return LIABILITY_TYPES.has(type) ? -1 : 1;
}

/** Stable dedupe key: transaction date + signed cents + normalized description. */
export function dedupeKey(date: string | null, amountCents: number | null, description: string): string {
  const d = (date ?? '').trim();
  const a = amountCents == null ? '' : String(amountCents);
  const desc = description.toUpperCase().replace(/\s+/g, ' ').trim();
  return `${d}|${a}|${desc}`;
}

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

/** Parse a dollar figure to cents, or null. Handles "$1,234.56", "(45.00)" (negative), "-12.30". */
function toCentsOrNull(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    return Math.round(raw * 100);
  }
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s === '') return null;
  let negative = false;
  // Accounting-style parentheses => negative.
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
  const cents = dollarsToCents(cleaned);
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

function toStringOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return s === '' ? null : s;
}

/** Last 4 digits pulled from any account-number-ish string; null when none. */
function toLast4(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 4) return digits.length > 0 ? digits.padStart(4, '0') : null;
  return digits.slice(-4);
}

function conf(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function toDirection(raw: unknown, signedAmountCents: number | null): TxnDirection {
  if (typeof raw === 'string') {
    const s = raw.trim().toUpperCase();
    if (['MONEY_OUT', 'OUT', 'DEBIT', 'CHARGE', 'WITHDRAWAL', 'PAYMENT_OUT', 'PURCHASE'].includes(s))
      return 'money_out';
    if (['MONEY_IN', 'IN', 'CREDIT', 'DEPOSIT', 'PAYMENT', 'REFUND', 'PAYMENT_IN'].includes(s))
      return 'money_in';
  }
  // Fall back to the sign of the amount the model gave.
  if (signedAmountCents != null && signedAmountCents > 0) return 'money_in';
  return 'money_out';
}

interface RawTxn {
  date?: unknown;
  transaction_date?: unknown;
  description?: unknown;
  amount?: unknown;
  direction?: unknown;
  running_balance?: unknown;
  confidence?: unknown;
}

/**
 * Compute the balance tie-out for a set of proposed lines against the statement's
 * opening & closing balances, using the account type to pick the sign direction.
 * Never throws. When either balance is missing it is `checkable: false` and `tied: true`
 * (we surface nothing we cannot verify), but the UI still shows the sum.
 */
export function computeBalanceTie(
  openingCents: number | null,
  closingCents: number | null,
  txns: Array<{ amount_cents: number | null }>,
  accountType: StatementAccountType,
  toleranceCents = 0,
): StatementBalanceTie {
  const sumCents = txns.reduce((acc, t) => acc + (t.amount_cents ?? 0), 0);
  const checkable = openingCents != null && closingCents != null;
  if (!checkable) {
    return {
      checkable: false,
      openingCents,
      closingCents,
      sumCents,
      expectedSumCents: null,
      differenceCents: null,
      tied: true,
      toleranceCents,
    };
  }
  const expectedSumCents = signFactorForType(accountType) * (closingCents - openingCents);
  const differenceCents = sumCents - expectedSumCents;
  return {
    checkable: true,
    openingCents,
    closingCents,
    sumCents,
    expectedSumCents,
    differenceCents,
    tied: Math.abs(differenceCents) <= toleranceCents,
    toleranceCents,
  };
}

/**
 * Pure normalizer: turn the model's loose JSON into a validated NormalizedStatement.
 * Signs each amount from its direction, keeps blank-on-unknown, and computes the
 * balance tie-out using the AUTHORITATIVE target `accountType` (not the model's guess),
 * so a credit-card statement ties liability-side. Never throws — a malformed shape
 * yields an empty transaction list with a not-checkable tie.
 */
export function normalizeStatementExtraction(
  raw: unknown,
  opts: { accountType: StatementAccountType },
): NormalizedStatement {
  const root = (raw ?? {}) as {
    account?: { name?: unknown; account_number?: unknown; last4?: unknown; type?: unknown };
    period_start?: unknown;
    period_end?: unknown;
    opening_balance?: unknown;
    closing_balance?: unknown;
    transactions?: unknown;
    document_note?: unknown;
  };

  const acct = root.account ?? {};
  const last4 = toLast4(acct.last4) ?? toLast4(acct.account_number);
  const account = {
    name: toStringOrNull(acct.name),
    last4,
    type: mapStatementAccountType(acct.type),
  };

  const openingCents = toCentsOrNull(root.opening_balance);
  const closingCents = toCentsOrNull(root.closing_balance);

  const list = Array.isArray(root.transactions) ? (root.transactions as RawTxn[]) : [];
  const transactions: ProposedStatementTxn[] = [];
  list.forEach((rt, index) => {
    if (rt == null || typeof rt !== 'object') return;
    const description = toStringOrNull(rt.description);
    // A line with neither a description nor an amount is noise — skip it.
    const rawAmount = toCentsOrNull(rt.amount);
    if (description == null && rawAmount == null) return;

    const direction = toDirection(rt.direction, rawAmount);
    // Sign the amount from the resolved direction (magnitude of whatever the model gave).
    const magnitude = rawAmount == null ? null : Math.abs(rawAmount);
    const amount_cents = magnitude == null ? null : direction === 'money_out' ? -magnitude : magnitude;

    const transaction_date = toIsoDate(rt.transaction_date) ?? toIsoDate(rt.date);
    const running_balance_cents = toCentsOrNull(rt.running_balance);
    const confidence = conf(rt.confidence);
    // Flag for review when the model was unsure OR a required field is missing.
    const lowConfidence =
      confidence < LOW_CONFIDENCE ||
      amount_cents == null ||
      transaction_date == null ||
      description == null;

    transactions.push({
      _id: `t${index}`,
      transaction_date,
      description: description ?? '',
      amount_cents,
      direction,
      running_balance_cents,
      confidence,
      lowConfidence,
    });
  });

  const balanceTie = computeBalanceTie(openingCents, closingCents, transactions, opts.accountType);

  return {
    account,
    periodStart: toIsoDate(root.period_start),
    periodEnd: toIsoDate(root.period_end),
    openingCents,
    closingCents,
    transactions,
    balanceTie,
    documentNote: toStringOrNull(root.document_note),
  };
}

const EXTRACTION_PROMPT = `You are an expert bookkeeper. Read this bank or credit-card statement and extract the account header, the statement period, the opening and closing balances, and EVERY transaction line.

Return ONLY valid JSON (no markdown, no prose) with this exact shape:
{
  "account": {
    "name": "string or null — the account holder / account name as printed",
    "account_number": "string or null — the account number exactly as printed (may be masked)",
    "last4": "string or null — the last 4 digits of the account number",
    "type": "one of: CHECKING | SAVINGS | CREDIT_CARD | LINE_OF_CREDIT | null"
  },
  "period_start": "YYYY-MM-DD or null — statement period start",
  "period_end": "YYYY-MM-DD or null — statement period end",
  "opening_balance": number or null — the beginning/previous balance in DOLLARS (not cents). For a credit-card statement this is the previous balance OWED,
  "closing_balance": number or null — the ending/new balance in DOLLARS. For a credit-card statement this is the new balance OWED,
  "transactions": [
    {
      "transaction_date": "YYYY-MM-DD — the posting/transaction date of this line",
      "description": "string — the merchant / payee / memo exactly as printed",
      "amount": number — the transaction amount in DOLLARS as a POSITIVE magnitude (do not sign it),
      "direction": "money_out | money_in — money_out = a debit / withdrawal / card CHARGE / purchase (money leaves the account or increases what is owed); money_in = a deposit / card PAYMENT / refund / credit",
      "running_balance": number or null — the running balance printed after this line, in DOLLARS,
      "confidence": number 0-1 — your confidence in this line
    }
  ],
  "document_note": "string or null — anything unusual (scanned/illegible, multiple accounts, no transactions found, totals did not foot)"
}

Rules:
- Extract ALL transaction lines in date order. Do NOT include summary/subtotal rows (e.g. 'Total Deposits', 'Total Withdrawals') as transactions.
- Amounts are POSITIVE magnitudes in whole dollars-and-cents; use "direction" to say whether money went out or in. NEVER sign the amount.
- For a credit-card statement: purchases/charges/fees/interest are direction "money_out"; payments and refunds/credits are "money_in".
- If a field is not stated, use null — NEVER invent a value.
- Dates as YYYY-MM-DD. If the year is only implied by the statement period, infer it from period_start/period_end.`;

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/**
 * Parse an uploaded bank/credit-card statement into a normalized proposed statement
 * THROUGH the Core AI gateway (metered, budget-capped per tenant; `orgId` scopes it,
 * `userId` attributes it). Accepts base64-encoded PDF or image data. The AUTHORITATIVE
 * target `accountType` is supplied by the caller (the bank_accounts row) so the balance
 * tie-out is computed liability-side for credit cards regardless of what the model guessed.
 * Never throws for the expected failure cases — returns `{ ok: false, ... }`.
 */
export async function parseBankStatement(
  deps: { supabase: SupabaseClient; anthropicApiKey: string },
  args: {
    orgId: string;
    userId?: string | null;
    base64Data: string;
    mediaType: string;
    accountType: StatementAccountType;
  },
): Promise<ParseStatementResult> {
  const { supabase, anthropicApiKey } = deps;
  const { orgId, userId, base64Data, mediaType, accountType } = args;
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
        feature: STATEMENT_EXTRACT_FEATURE,
        model: STATEMENT_EXTRACT_MODEL,
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
    console.error('[statement-parse] Failed to parse model JSON:', jsonStr.slice(0, 500));
    return { ok: false, error: 'Failed to parse AI response as JSON' };
  }

  const statement = normalizeStatementExtraction(parsed, { accountType });

  return {
    ok: true,
    statement,
    model: gw.model_used ?? STATEMENT_EXTRACT_MODEL,
    correlationId: gw.correlation_id ?? null,
    extractionMs: Date.now() - startTime,
  };
}
