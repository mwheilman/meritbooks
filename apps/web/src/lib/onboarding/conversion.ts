/**
 * Onboarding — Historical Conversion (pure domain logic).
 *
 * The make-or-break onboarding phase: take a new tenant's PRIOR books (a trial
 * balance / GL export from QuickBooks, Sage, etc. — one-time import sources, per
 * canon §1) and turn them into a single balanced OPENING journal entry, gated on
 * a human tie-out.
 *
 * Division of labor (canon §3 — "AI proposes FACTS; the deterministic engine does
 * the accounting; a human approves"):
 *   • The AI proposes the source-account -> tenant-COA MAPPING only. It never sees
 *     or authors a balance — every dollar in this module comes from the uploaded
 *     numbers and is aggregated in code here.
 *   • This module assembles the proposed opening balances, nets them per account,
 *     and VALIDATES that debits == credits.
 *   • Go-live (posting the opening entry) is BLOCKED until a human marks the
 *     opening trial balance tied-out; only then does the caller post through the
 *     deterministic engine (postJournalEntry), which re-checks balance at the DB.
 *
 * This file is PURE (no Supabase, no gateway) so the balance validator and the
 * mapping application can be unit-tested against fixed fixtures.
 */

import type { ImportFieldDef } from '@/lib/import/definitions';

// ─────────────────────────────────────────────────────────────────────────────
// CSV source shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fields expected in an uploaded trial-balance / GL-balances export. The account
 * NAME is optional but, when present, materially improves AI mapping accuracy.
 * `debit`/`credit` are dollars in the CSV → cents in the DB (money coercion).
 */
export const CONVERSION_SOURCE_FIELDS: ImportFieldDef[] = [
  {
    key: 'source_account',
    label: 'Source Account',
    type: 'text',
    required: true,
    aliases: ['account', 'acct', 'account number', 'account code', 'gl', 'number', 'code'],
    help: 'The account number/code as it appears in your prior system.',
  },
  {
    key: 'source_name',
    label: 'Source Account Name',
    type: 'text',
    aliases: ['name', 'account name', 'description', 'label', 'title'],
    help: 'The account name from your prior system — helps the AI map it correctly.',
  },
  {
    key: 'debit_cents',
    label: 'Debit',
    type: 'money',
    aliases: ['debit', 'dr', 'debits', 'debit balance'],
  },
  {
    key: 'credit_cents',
    label: 'Credit',
    type: 'money',
    aliases: ['credit', 'cr', 'credits', 'credit balance'],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** One row of the uploaded prior-books export. Balances are the source of truth. */
export interface SourceLine {
  sourceAccount: string;
  sourceName: string | null;
  debitCents: number;
  creditCents: number;
}

/** A single distinct source account, WITHOUT any balance — this is all the AI sees. */
export interface SourceAccountRef {
  sourceAccount: string;
  sourceName: string | null;
}

export type MappingSource = 'ai' | 'heuristic' | 'human' | 'unmapped';

/** How one source account maps to the tenant chart of accounts. */
export interface AccountMapping {
  /** Target tenant account number, or null when not yet mapped. */
  targetAccountNumber: string | null;
  confidence: number | null;
  source: MappingSource;
  reasoning?: string;
}

/** The full mapping: source account code -> its mapping decision. */
export type MappingTable = Record<string, AccountMapping>;

/** One line of the assembled opening trial balance (netted per target account). */
export interface OpeningBalanceLine {
  targetAccountNumber: string;
  targetName: string | null;
  debitCents: number;
  creditCents: number;
  /** Source account codes that rolled up into this target account. */
  sourceAccounts: string[];
}

/** Result of the balance check — the blocking tie-out signal. */
export interface BalanceCheck {
  balanced: boolean;
  totalDebitCents: number;
  totalCreditCents: number;
  /** debits − credits; zero when balanced. */
  differenceCents: number;
}

/** Everything the mapping step produced, ready to review. */
export interface AssembledOpeningTb {
  openingBalances: OpeningBalanceLine[];
  balance: BalanceCheck;
  /** Source accounts with a non-zero balance that are not mapped to a target. */
  unmapped: string[];
  /** Mapped target numbers that do not exist in the tenant chart of accounts. */
  unknownTargets: string[];
  /** Raw source totals, for the human to reconcile book-vs-source. */
  sourceTotals: { debitCents: number; creditCents: number };
}

/** A known tenant account, used to name opening lines and validate targets. */
export interface TargetAccount {
  accountNumber: string;
  name: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation & assembly (balances come ONLY from source numbers)
// ─────────────────────────────────────────────────────────────────────────────

/** Distinct source accounts (no balances) — the only thing handed to the AI. */
export function distinctSourceAccounts(lines: SourceLine[]): SourceAccountRef[] {
  const seen = new Map<string, SourceAccountRef>();
  for (const l of lines) {
    const key = l.sourceAccount.trim();
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, { sourceAccount: key, sourceName: l.sourceName ?? null });
    else if (!seen.get(key)!.sourceName && l.sourceName) seen.get(key)!.sourceName = l.sourceName;
  }
  return [...seen.values()];
}

/** Raw debit/credit totals of the uploaded file (for book-vs-source reconciliation). */
export function sourceTotals(lines: SourceLine[]): { debitCents: number; creditCents: number } {
  return lines.reduce(
    (acc, l) => ({ debitCents: acc.debitCents + (l.debitCents || 0), creditCents: acc.creditCents + (l.creditCents || 0) }),
    { debitCents: 0, creditCents: 0 },
  );
}

/**
 * Apply a mapping to the source lines and assemble the proposed opening trial
 * balance. Every cent is aggregated here from `lines`; the mapping only decides
 * WHICH target account each source amount rolls into. Amounts are netted per
 * target account so each target contributes a single debit OR credit.
 */
export function applyMapping(
  lines: SourceLine[],
  mapping: MappingTable,
  targets: TargetAccount[],
): AssembledOpeningTb {
  const targetByNumber = new Map(targets.map((t) => [t.accountNumber, t]));

  // Aggregate source amounts per TARGET account.
  interface Agg { debit: number; credit: number; sources: Set<string> }
  const byTarget = new Map<string, Agg>();
  const unmapped = new Set<string>();
  const unknownTargets = new Set<string>();

  for (const line of lines) {
    const src = line.sourceAccount.trim();
    const debit = line.debitCents || 0;
    const credit = line.creditCents || 0;
    if (debit === 0 && credit === 0) continue; // zero rows never need mapping

    const m = mapping[src];
    const target = m?.targetAccountNumber ?? null;
    if (!target) {
      unmapped.add(src);
      continue;
    }
    if (!targetByNumber.has(target)) unknownTargets.add(target);

    let agg = byTarget.get(target);
    if (!agg) { agg = { debit: 0, credit: 0, sources: new Set() }; byTarget.set(target, agg); }
    agg.debit += debit;
    agg.credit += credit;
    agg.sources.add(src);
  }

  const openingBalances: OpeningBalanceLine[] = [];
  for (const [targetAccountNumber, agg] of byTarget) {
    // Net to a single debit or credit for this account.
    const net = agg.debit - agg.credit;
    if (net === 0) continue; // fully offsetting → contributes nothing
    openingBalances.push({
      targetAccountNumber,
      targetName: targetByNumber.get(targetAccountNumber)?.name ?? null,
      debitCents: net > 0 ? net : 0,
      creditCents: net < 0 ? -net : 0,
      sourceAccounts: [...agg.sources].sort(),
    });
  }
  openingBalances.sort((a, b) => a.targetAccountNumber.localeCompare(b.targetAccountNumber));

  return {
    openingBalances,
    balance: validateOpeningBalance(openingBalances),
    unmapped: [...unmapped].sort(),
    unknownTargets: [...unknownTargets].sort(),
    sourceTotals: sourceTotals(lines),
  };
}

/**
 * The balance validator — the blocking tie-out check. Debits must equal credits.
 * Pure and total: safe to run on every recompute and unit-test directly.
 */
export function validateOpeningBalance(lines: OpeningBalanceLine[]): BalanceCheck {
  let totalDebitCents = 0;
  let totalCreditCents = 0;
  for (const l of lines) {
    totalDebitCents += l.debitCents || 0;
    totalCreditCents += l.creditCents || 0;
  }
  const differenceCents = totalDebitCents - totalCreditCents;
  return { balanced: differenceCents === 0, totalDebitCents, totalCreditCents, differenceCents };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate predicates
// ─────────────────────────────────────────────────────────────────────────────

/** Reasons the opening TB cannot yet be tied out / posted. Empty ⇒ ready. */
export function tieOutBlockers(tb: AssembledOpeningTb): string[] {
  const blockers: string[] = [];
  if (tb.openingBalances.length < 2) {
    blockers.push('An opening entry needs at least two accounts with balances.');
  }
  if (!tb.balance.balanced) {
    blockers.push(
      `Out of balance by ${centsAbs(tb.balance.differenceCents)} — debits ${tb.balance.totalDebitCents} vs credits ${tb.balance.totalCreditCents} (cents).`,
    );
  }
  if (tb.unmapped.length > 0) {
    blockers.push(`${tb.unmapped.length} source account(s) with balances are not mapped: ${tb.unmapped.slice(0, 8).join(', ')}${tb.unmapped.length > 8 ? '…' : ''}.`);
  }
  if (tb.unknownTargets.length > 0) {
    blockers.push(`${tb.unknownTargets.length} mapped account(s) do not exist in this chart of accounts: ${tb.unknownTargets.slice(0, 8).join(', ')}${tb.unknownTargets.length > 8 ? '…' : ''}.`);
  }
  return blockers;
}

function centsAbs(n: number): string {
  return String(Math.abs(n));
}

// ─────────────────────────────────────────────────────────────────────────────
// Persisted session shape (stored as ai_decisions.proposed_output JSON — reuses
// the existing AI-decision staging table; no new migration this wave)
// ─────────────────────────────────────────────────────────────────────────────

export const CONVERSION_KIND = 'ONBOARDING_CONVERSION' as const;
export const CONVERSION_FEATURE = 'CONVERSION_MAP' as const;

export interface ConversionSessionData {
  kind: typeof CONVERSION_KIND;
  companyId: string;
  companyShortCode: string;
  asOfDate: string;
  sourceLines: SourceLine[];
  mapping: MappingTable;
  openingBalances: OpeningBalanceLine[];
  balance: BalanceCheck;
  unmapped: string[];
  unknownTargets: string[];
  sourceTotals: { debitCents: number; creditCents: number };
  tiedOut: boolean;
  tiedOutBy: string | null;
  tiedOutAt: string | null;
}

/** Re-derive the assembled TB from stored source + mapping and fold it back in. */
export function recompute(
  data: Pick<ConversionSessionData, 'sourceLines' | 'mapping'>,
  targets: TargetAccount[],
): AssembledOpeningTb {
  return applyMapping(data.sourceLines, data.mapping, targets);
}

/**
 * Build the balanced opening journal-entry lines for the posting engine. Each
 * opening line resolves to an account id; each contributes exactly one debit or
 * credit. Throws (via the returned `missing`) when an account id is unresolved.
 */
export interface OpeningEntryLine {
  account_id: string;
  debit_cents: number;
  credit_cents: number;
  memo: string;
}

export function buildOpeningEntryLines(
  openingBalances: OpeningBalanceLine[],
  accountIdByNumber: Map<string, string>,
): { lines: OpeningEntryLine[]; missing: string[] } {
  const lines: OpeningEntryLine[] = [];
  const missing: string[] = [];
  for (const b of openingBalances) {
    const accountId = accountIdByNumber.get(b.targetAccountNumber);
    if (!accountId) { missing.push(b.targetAccountNumber); continue; }
    lines.push({
      account_id: accountId,
      debit_cents: b.debitCents,
      credit_cents: b.creditCents,
      memo: `Opening balance — ${b.targetAccountNumber}${b.targetName ? ` ${b.targetName}` : ''}`,
    });
  }
  return { lines, missing };
}
