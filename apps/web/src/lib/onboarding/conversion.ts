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
import { subledgerControlBlockers, type SubledgerControlTie } from './reconciliation/tie-out';

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
  {
    key: 'amount_cents',
    label: 'Signed Balance',
    type: 'money',
    aliases: ['ending balance', 'net balance', 'signed balance'],
    help:
      'Optional — only if your file has ONE signed balance column instead of separate ' +
      'Debit / Credit columns. Positive = debit, negative = credit.',
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
  /** Target account type (ASSET/LIABILITY/EQUITY/REVENUE/COGS/OPEX/OTHER), when known. */
  targetType?: string | null;
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

/**
 * The balance-sheet identity check (Assets = Liabilities + Equity). A correct
 * go-live opening balance contains ONLY balance-sheet accounts — the prior year's
 * P&L is already closed into retained earnings, so income-statement accounts should
 * be zero. When `standalone` is false the balance sheet does not stand on its own:
 * income-statement accounts carry balances (`plNetCents`, a mid-year go-live) that
 * must be consciously acknowledged before posting. All figures are cents, expressed
 * in each section's NORMAL balance (assets debit-positive; liabilities/equity/net
 * income credit-positive).
 */
export interface BalanceSheetCheck {
  assetsCents: number;
  liabilitiesCents: number;
  equityCents: number;
  /** Net income sitting in income-statement accounts (revenue − expenses). */
  plNetCents: number;
  /** Assets − (Liabilities + Equity); equals plNetCents when debits == credits. */
  identityDiffCents: number;
  /** True when the balance sheet ties on its own (no open income-statement balances). */
  standalone: boolean;
  /** Target accounts whose type could not be classified (defensive; normally empty). */
  untyped: string[];
}

/** Everything the mapping step produced, ready to review. */
export interface AssembledOpeningTb {
  openingBalances: OpeningBalanceLine[];
  balance: BalanceCheck;
  /** The balance-sheet identity (Assets = Liabilities + Equity) breakdown. */
  balanceSheet: BalanceSheetCheck;
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
  /** account_type_enum value (ASSET/LIABILITY/EQUITY/REVENUE/COGS/OPEX/OTHER). */
  accountType?: string | null;
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
      targetType: targetByNumber.get(targetAccountNumber)?.accountType ?? null,
      debitCents: net > 0 ? net : 0,
      creditCents: net < 0 ? -net : 0,
      sourceAccounts: [...agg.sources].sort(),
    });
  }
  openingBalances.sort((a, b) => a.targetAccountNumber.localeCompare(b.targetAccountNumber));

  return {
    openingBalances,
    balance: validateOpeningBalance(openingBalances),
    balanceSheet: validateBalanceSheet(openingBalances),
    unmapped: [...unmapped].sort(),
    unknownTargets: [...unknownTargets].sort(),
    sourceTotals: sourceTotals(lines),
  };
}

/**
 * The balance-sheet identity check. Classifies each opening line by account type and
 * confirms whether the balance sheet ties on its own (Assets = Liabilities + Equity).
 * A residual means income-statement accounts carry balances — a mid-year go-live that
 * must be acknowledged before posting. Pure and total.
 */
export function validateBalanceSheet(lines: OpeningBalanceLine[]): BalanceSheetCheck {
  let assetsCents = 0;
  let liabilitiesCents = 0;
  let equityCents = 0;
  let plNetCents = 0;
  const untyped: string[] = [];
  for (const l of lines) {
    const net = (l.debitCents || 0) - (l.creditCents || 0); // debit-positive
    switch ((l.targetType ?? '').toUpperCase()) {
      case 'ASSET':
        assetsCents += net;
        break;
      case 'LIABILITY':
        liabilitiesCents += -net; // credit-positive
        break;
      case 'EQUITY':
        equityCents += -net; // credit-positive
        break;
      case 'REVENUE':
      case 'COGS':
      case 'OPEX':
      case 'OTHER':
        plNetCents += -net; // credit-positive → net income
        break;
      default:
        untyped.push(l.targetAccountNumber);
        // Unknown type: fold into the P&L residual so the identity math is complete.
        plNetCents += -net;
        break;
    }
  }
  const identityDiffCents = assetsCents - (liabilitiesCents + equityCents);
  // The balance sheet ties on its own only when there is no open income-statement net.
  const standalone = plNetCents === 0 && untyped.length === 0;
  return { assetsCents, liabilitiesCents, equityCents, plNetCents, identityDiffCents, standalone, untyped };
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

/**
 * Reasons the opening TB cannot yet be tied out / posted. Empty ⇒ ready.
 *
 * Two balance gates apply: (1) debits == credits — the hard posting requirement; and
 * (2) the balance-sheet identity (Assets = Liabilities + Equity). The identity gate
 * fires only when income-statement accounts carry balances and the user has NOT
 * acknowledged a mid-year go-live (`plAcknowledged`) — so a clean year-end opening TB
 * passes with no extra step, while a mid-year one forces a conscious confirmation.
 */
export function tieOutBlockers(
  tb: Omit<AssembledOpeningTb, 'balanceSheet'> & { balanceSheet?: BalanceSheetCheck },
  opts?: { plAcknowledged?: boolean },
): string[] {
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
  // Balance-sheet identity gate: assets must equal liabilities + equity. When the
  // difference is exactly the open income-statement net, it's a mid-year go-live the
  // user can acknowledge; anything else is a genuine imbalance and always blocks.
  const bs = tb.balanceSheet;
  if (bs && tb.balance.balanced && !bs.standalone) {
    if (bs.untyped.length > 0) {
      blockers.push(`${bs.untyped.length} account(s) could not be classified by type — check the chart of accounts: ${bs.untyped.slice(0, 8).join(', ')}${bs.untyped.length > 8 ? '…' : ''}.`);
    }
    if (bs.plNetCents !== 0 && !opts?.plAcknowledged) {
      blockers.push(
        `Balance sheet does not stand alone — income-statement accounts carry ${centsAbs(bs.plNetCents)} (cents) of open balances. ` +
        'A year-end opening balance normally has none (prior P&L is closed to retained earnings). ' +
        'Confirm this is an intended mid-year go-live to proceed.',
      );
    }
  }
  return blockers;
}

function centsAbs(n: number): string {
  return String(Math.abs(n));
}

// ─────────────────────────────────────────────────────────────────────────────
// Extended tie-out (subledger→control & WIP→GL) — ADDITIVE to the base gate above.
// The pure subledger/WIP tie MATH lives in ./reconciliation/tie-out.ts (cents-only,
// role-resolved by the caller). This composer is what the go-live gate consumes: the
// base tie-out blockers PLUS the subledger-control blockers. When no subledger detail
// was imported the tie list is empty and this is identical to tieOutBlockers — so it
// is a safe, backward-compatible drop-in for the gate.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Imported subledger / WIP detail totals staged alongside the opening TB (cents).
 * Each is a magnitude in its account's normal orientation. Optional — a field is
 * present only when that subledger was actually imported for this conversion. No
 * schema change: this rides inside the existing `ai_decisions.proposed_output` JSON.
 */
export interface ImportedSubledgerDetail {
  /** Σ open trade AR by customer (ties to AR_CONTROL / 1100). */
  arOpenByCustomerCents?: number;
  /** Σ open AP by vendor (ties to AP_CONTROL). */
  apOpenByVendorCents?: number;
  /** Σ retainage receivable detail (ties to RETAINAGE_RECEIVABLE). */
  retainageReceivableCents?: number;
  /** Σ retainage payable detail (ties to RETAINAGE_PAYABLE). */
  retainagePayableCents?: number;
  /** Σ job costs-to-date (ties to JOB_WIP asset). */
  wipCostsToDateCents?: number;
  /** Σ unbilled / costs & earnings in excess of billings (ties to UNBILLED_RECEIVABLE / 1180). */
  unbilledCents?: number;
  /** Σ billings in excess of costs & earnings (ties to DEFERRED_REVENUE / 2410). */
  billingsInExcessCents?: number;
}

/**
 * The go-live blocking predicate the gate consumes: the base opening-TB blockers plus
 * the subledger→control / WIP→GL blockers. The subledger ties are computed by the
 * caller (which resolves each control account BY ROLE and reads its balance in cents)
 * and passed in — keeping this a pure composition. Empty `subledgerTies` ⇒ base gate.
 */
export function extendedTieOutBlockers(
  tb: Omit<AssembledOpeningTb, 'balanceSheet'> & { balanceSheet?: BalanceSheetCheck },
  subledgerTies: SubledgerControlTie[],
  opts?: { plAcknowledged?: boolean },
): string[] {
  return [...tieOutBlockers(tb, opts), ...subledgerControlBlockers(subledgerTies)];
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
  /** Balance-sheet identity breakdown (optional for sessions staged before this shipped). */
  balanceSheet?: BalanceSheetCheck;
  unmapped: string[];
  unknownTargets: string[];
  sourceTotals: { debitCents: number; creditCents: number };
  /** The user confirmed a mid-year go-live (open income-statement balances are intended). */
  plAcknowledged?: boolean;
  /**
   * Imported subledger / WIP detail totals, when those subledgers were brought in for
   * this conversion. Consumed by the extended go-live tie-out (subledger→control /
   * WIP→GL) and the Conversion Reconciliation report. Optional — absent for a
   * TB-only conversion. Rides inside this JSON; no schema change.
   */
  subledgerDetail?: ImportedSubledgerDetail;
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
