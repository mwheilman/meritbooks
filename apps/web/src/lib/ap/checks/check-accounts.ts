/**
 * Which bank accounts can a check be drawn on — PURE (no I/O).
 *
 * `bank_accounts.account_type` (migration 005) only knows CHECKING / SAVINGS / CREDIT_CARD /
 * LINE_OF_CREDIT, and the Plaid link flow stores Plaid's non-cash accounts (401k, IRA, HSA,
 * brokerage, mortgage, student loan …) as CHECKING because the CHECK constraint has no
 * "other" value (lib/money/plaid-feed.ts). So the type alone is not enough: an account is
 * check-capable only when it is an active CHECKING account AND nothing in its name or
 * institution says it is a retirement, health-savings, investment, savings or loan account.
 *
 * Ordering for the picker: the account with a check-stock profile first (it is the one the
 * company actually prints on), then accounts whose name says checking/operating, then name.
 */

export interface CheckAccountCandidate {
  id: string;
  account_type: string;
  account_name: string | null;
  institution_name?: string | null;
  is_active?: boolean | null;
}

/** Words that mark an account as NOT a check-writing operating account. */
const NON_CHECKING: ReadonlyArray<RegExp> = [
  /\b401\s*\(?k\)?/i,
  /\b403\s*\(?b\)?/i,
  /\b457\b/i,
  /\b529\b/i,
  /\b(roth|sep|simple|traditional|rollover)\s+ira\b/i,
  /\bira\b/i,
  /\bhsa\b/i,
  /\bfsa\b/i,
  /health\s+savings/i,
  /retirement/i,
  /pension/i,
  /annuity/i,
  /brokerage/i,
  /investment/i,
  /\bstocks?\b/i,
  /mortgage/i,
  /\bheloc\b/i,
  /home\s+equity/i,
  /\bloans?\b/i,
  /student/i,
  /line\s+of\s+credit/i,
  /\bloc\b/i,
  /credit\s+card/i,
  /\bvisa\b|\bmastercard\b|\bamex\b/i,
  /savings/i,
  /money\s+market/i,
  /\bcd\b/i,
  /certificate\s+of\s+deposit/i,
  /escrow/i,
];

/** Words that positively say "this is a checking/operating account". */
const CHECKING_WORDS = /checking|operating|\bdda\b|demand\s+deposit|payroll|disbursement|\bchk\b/i;

/** Why an account is excluded (null = it can issue checks). */
export function checkIneligibleReason(a: CheckAccountCandidate): string | null {
  if (a.is_active === false) return 'Inactive account.';
  if (a.account_type !== 'CHECKING') return 'Not a checking account.';
  const text = `${a.account_name ?? ''} ${a.institution_name ?? ''}`;
  if (NON_CHECKING.some((re) => re.test(text))) return 'Retirement, savings, investment or loan account — checks cannot be drawn on it.';
  return null;
}

export function canIssueChecks(a: CheckAccountCandidate): boolean {
  return checkIneligibleReason(a) === null;
}

/**
 * The check-capable accounts, ordered for the picker: stock profile first, then accounts
 * named checking/operating, then alphabetical.
 */
export function checkAccountsForPicker<T extends CheckAccountCandidate>(rows: readonly T[], withStockProfile: ReadonlySet<string>): T[] {
  const rank = (a: T) => (withStockProfile.has(a.id) ? 0 : CHECKING_WORDS.test(a.account_name ?? '') ? 1 : 2);
  return rows
    .filter(canIssueChecks)
    .slice()
    .sort((a, b) => rank(a) - rank(b) || (a.account_name ?? '').localeCompare(b.account_name ?? ''));
}

/** The account the picker opens on: first in picker order (stock profile wins), else null. */
export function defaultCheckAccountId(accounts: ReadonlyArray<{ id: string; hasStockProfile?: boolean }>): string | null {
  return (accounts.find((a) => a.hasStockProfile) ?? accounts[0])?.id ?? null;
}
