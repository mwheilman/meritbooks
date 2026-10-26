/**
 * Onboarding v2 — the 24 data-quality preflight checks (docs/ia/08-ONBOARDING-V2-SPEC.md §8).
 *
 * Generalizes `integrations/erp/quickbooks/preflight.ts` (PF-01..PF-06) to every source.
 * Pure, deterministic and AI-free: no I/O, no clock (every date comes from the input), integer
 * cents only. `runPreflight` ALWAYS returns exactly 24 results, one per check, in PF order.
 *
 * Severity contract (§8 table):
 *   • PF-01 / PF-02 / PF-07 / PF-08 are blockers when they fail.
 *   • PF-10 is a warning; a blocker when the last reconciliation (or the oldest uncleared item)
 *     is more than 180 days before cutover.
 *   • PF-20 is a blocker when the WIP schedule doesn't tie to the GL.
 *   • PF-13 and PF-24 are info. Everything else is a warning.
 *   • A clean check is `passed` with a positive title; a check whose data isn't there yet is
 *     `not_applicable` and its message says exactly what to drop or connect. Never a fake pass.
 *
 * Sign convention: account balances are DEBIT-POSITIVE (a liability or revenue account is
 * normally negative). Open invoices / bills carry their open balance as a positive number.
 *
 * Account detection order (per check): the source's detail/sub type and type first (QuickBooks
 * `AccountsReceivable`, `UndepositedFunds`, `Bank` …); then the account name; then the
 * MeritBooks type. Control accounts (A/R, A/P, bank) trust the source typing exclusively when
 * it's present, because an aging report only covers accounts of that type.
 *
 * Judgment calls (documented so the lead / auditor can overrule):
 *   • Balance checks need a cutover trial balance (`tbAvailable` + accounts); without one they
 *     are not_applicable with "drop the trial balance" guidance.
 *   • PF-08 — `priorYear.retainedEarningsCents` is the Retained Earnings line on last year's
 *     year-end balance sheet (which, in QuickBooks-style books, excludes that year's Net Income
 *     line) and `netIncomeCents` is last year's net income, BOTH CREDIT-POSITIVE (a profit is
 *     positive). Expected RE at cutover = the two added together; actual RE = −(Σ debit-positive
 *     RE balances). Any difference (e.g. entries posted straight to RE, or a year never closed)
 *     is a blocker.
 *   • PF-10 — no reconciliation on record (null date) is a warning, not a blocker: it may just
 *     mean the rec report wasn't dropped yet.
 *   • PF-14 — `is1099` true AND paid at or above the federal 1099-NEC/MISC threshold this year
 *     AND no tax ID. The threshold is $600 through tax year 2025 and $2,000 from 2026 (P.L.
 *     119-21 §70433); see `form1099ThresholdCents`. `PfParty.is1099` is non-nullable, so the
 *     "no flag, infer from payments" path doesn't arise.
 *   • PF-11 — `books_closed` evidence with a non-zero amount = changes found dated inside the
 *     closed period; `sourceChangedSincePull` = the source moved after we pulled it.
 *   • PF-20 — cost-to-date is compared to a WIP asset only when the chart HAS one (otherwise job
 *     cost sits in cost of sales, which is normal). Unbilled and billings-in-excess are always
 *     compared (a schedule showing them with nothing in the GL is exactly the break). Every job on
 *     the schedule is treated as rev-rec managed.
 *   • PF-22 — a pair is a mirror when thisSide + otherSide = 0. A pair waiting on the other
 *     client's books is a warning too; its dollars at stake count toward the amount.
 *   • PF-23 — "same customers": ledger invoices are limited to customers that appear in the
 *     field system; the amount is the GROSS of every per-invoice difference, so offsetting
 *     errors can't hide.
 */

import type {
  MeritAccountType,
  PfAccount,
  PfEvidence,
  PfOpenItem,
  PfParty,
  PreflightCheckId,
  PreflightInput,
  PreflightResult,
  PreflightSeverity,
} from '../types';
import { daysBetween, dollars, longDate, plural, wholeDollars } from '../format';

// ── The catalog ─────────────────────────────────────────────────────────────────

/** The 24 checks, in order. `blocking` = the check CAN stop "Prove balances". */
export const PREFLIGHT_CHECKS: ReadonlyArray<{ id: PreflightCheckId; name: string; blocking: boolean }> = [
  { id: 'PF-01', name: 'Receivables match the A/R account', blocking: true },
  { id: 'PF-02', name: 'Payables match the A/P account', blocking: true },
  { id: 'PF-03', name: 'Undeposited Funds is empty', blocking: false },
  { id: 'PF-04', name: 'Nothing left uncategorized', blocking: false },
  { id: 'PF-05', name: 'Nothing parked in Ask My Accountant or suspense', blocking: false },
  { id: 'PF-06', name: 'Opening Balance Equity is zero', blocking: false },
  { id: 'PF-07', name: 'Trial balance balances', blocking: true },
  { id: 'PF-08', name: 'Retained earnings rolls forward', blocking: true },
  { id: 'PF-09', name: 'Balances have normal signs', blocking: false },
  { id: 'PF-10', name: 'Bank accounts reconciled recently', blocking: true },
  { id: 'PF-11', name: 'No edits to closed periods', blocking: false },
  { id: 'PF-12', name: 'No inactive accounts with balances', blocking: false },
  { id: 'PF-13', name: 'No duplicate customers or vendors', blocking: false },
  { id: 'PF-14', name: '1099 vendors have a tax ID', blocking: false },
  { id: 'PF-15', name: 'Sales tax ties to the return', blocking: false },
  { id: 'PF-16', name: 'Payroll liabilities are current', blocking: false },
  { id: 'PF-17', name: 'Depreciation is up to date', blocking: false },
  { id: 'PF-18', name: 'Deposits aren’t booked as revenue', blocking: false },
  { id: 'PF-19', name: 'Retainage is kept separate', blocking: false },
  { id: 'PF-20', name: 'Job schedule (WIP) matches the books', blocking: true },
  { id: 'PF-21', name: 'Loans match the lender', blocking: false },
  { id: 'PF-22', name: 'Intercompany balances mirror each other', blocking: false },
  { id: 'PF-23', name: 'Field-system invoices match the ledger', blocking: false },
  { id: 'PF-24', name: 'All balances are in US dollars', blocking: false },
];

/** Federal 1099-NEC/MISC reporting threshold for the cutover's tax year (unknown year → $600, the lower). */
export function form1099ThresholdCents(asOf: string | null): number {
  const year = asOf && /^\d{4}/.test(asOf) ? Number(asOf.slice(0, 4)) : NaN;
  return Number.isFinite(year) && year >= 2026 ? 200_000 : 60_000;
}

// ── Result builders ─────────────────────────────────────────────────────────────

type Body = Omit<PreflightResult, 'checkId' | 'name'>;

interface BodyInput {
  severity: PreflightSeverity;
  title: string;
  message: string;
  fix?: string;
  amountCents?: number;
  accounts?: string[];
  sample?: string[];
  count?: number;
}

function body(p: BodyInput): Body {
  const sample = p.sample ?? [];
  return {
    severity: p.severity,
    title: p.title,
    message: p.message,
    fix: p.fix ?? 'Nothing to do.',
    amountCents: Math.abs(Math.trunc(p.amountCents ?? 0)),
    accounts: p.accounts ?? [],
    records: { sample: sample.slice(0, 5), count: p.count ?? sample.length },
  };
}

function na(title: string, message: string, fix?: string): Body {
  return body({ severity: 'not_applicable', title, message, fix: fix ?? message });
}

function pass(title: string, message: string, extra: Partial<BodyInput> = {}): Body {
  return body({ ...extra, severity: 'passed', title, message });
}

// ── Small pure helpers ──────────────────────────────────────────────────────────

const sum = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0);
const sumBal = (as: readonly PfAccount[]): number => sum(as.map((a) => a.balanceCents));
const sumAbs = (as: readonly PfAccount[]): number => sum(as.map((a) => Math.abs(a.balanceCents)));
const nonZero = (as: readonly PfAccount[]): PfAccount[] => as.filter((a) => a.balanceCents !== 0);
const label = (a: PfAccount): string => (a.number ? `${a.number} ${a.name}` : a.name).trim();
const labels = (as: readonly PfAccount[]): string[] => as.map(label);
const list = (xs: readonly string[]): string => {
  if (xs.length <= 1) return xs.join('');
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
};
const shortList = (xs: readonly string[], max = 3): string =>
  xs.length <= max ? list(xs) : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`;

/** Compact detail-type key: "Accounts Receivable" / "AccountsReceivable" → "accountsreceivable". */
const key = (s: string | null): string => (s ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const dt = (a: PfAccount): string => key(a.detailType);
const st = (a: PfAccount): string => (a.sourceType ?? '').toLowerCase();
const typed = (a: PfAccount): boolean => !!(a.detailType || a.sourceType);

/** Lower-case, "&" → "and", no punctuation, no Inc/LLC/Co/Corp/Ltd/The. */
const ENTITY_SUFFIX = /\b(incorporated|inc|llc|l l c|pllc|llp|lp|pc|co|company|corp|corporation|ltd|limited|the)\b/g;
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(ENTITY_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Account classifiers ─────────────────────────────────────────────────────────

const isType = (a: PfAccount, ...ts: MeritAccountType[]): boolean => a.type !== null && ts.includes(a.type);
const assetish = (a: PfAccount): boolean => {
  if (a.sourceType) return /asset|bank|receivable|inventory/.test(st(a));
  return a.type === null || a.type === 'ASSET';
};
const liabilityish = (a: PfAccount): boolean => {
  if (a.sourceType) return /liabilit|payable|credit card/.test(st(a));
  return a.type === null || a.type === 'LIABILITY';
};
const plish = (a: PfAccount): boolean =>
  isType(a, 'REVENUE', 'COGS', 'OPEX', 'OTHER') || /income|expense|cost of goods/.test(st(a));

const isRetainage = (a: PfAccount): boolean => /retainage|retention/i.test(a.name);
const isDueToFrom = (a: PfAccount): boolean => /due\s+(from|to)\b/i.test(a.name);

function isAR(a: PfAccount): boolean {
  if (typed(a)) return dt(a) === 'accountsreceivable' || /accounts?\s*receivable/.test(st(a));
  return /accounts?\s+receivable|\ba\/r\b/i.test(a.name);
}
function isAP(a: PfAccount): boolean {
  if (typed(a)) return dt(a) === 'accountspayable' || /accounts?\s*payable/.test(st(a));
  return /accounts?\s+payable|\ba\/p\b/i.test(a.name);
}
const BANK_DETAIL = new Set(['checking', 'savings', 'moneymarket', 'cashonhand', 'trustaccounts', 'rentsheldintrust', 'cashandcashequivalents', 'bank']);
function isBank(a: PfAccount): boolean {
  if (typed(a)) return BANK_DETAIL.has(dt(a)) || st(a) === 'bank';
  return (a.type === null || a.type === 'ASSET') && /\bchecking\b|\bsavings\b|\bcash\b|money\s+market|\bbank\b/i.test(a.name) && !/undeposited/i.test(a.name);
}
const isUndeposited = (a: PfAccount): boolean => dt(a) === 'undepositedfunds' || /undeposited/i.test(a.name);
const isUncategorized = (a: PfAccount): boolean => /uncategori[sz]ed/i.test(a.name);
const isSuspense = (a: PfAccount): boolean => /ask\s+my\s+accountant|suspense/i.test(a.name);
const isOBE = (a: PfAccount): boolean => dt(a) === 'openingbalanceequity' || /opening\s+bal(ance)?\.?\s+equity/i.test(a.name);
const isRE = (a: PfAccount): boolean => dt(a) === 'retainedearnings' || /retained\s+earnings/i.test(a.name);
function isInventory(a: PfAccount): boolean {
  if (dt(a) === 'inventory' || /inventory/.test(st(a))) return true;
  return !typed(a) && (a.type === null || a.type === 'ASSET') && /inventory/i.test(a.name);
}
const isAccumDep = (a: PfAccount): boolean => dt(a) === 'accumulateddepreciation' || /accum\w*\.?\s.*deprec/i.test(a.name);
const FA_DETAIL = /^(fixedasset|buildings$|vehicles$|machineryandequipment$|furnitureandfixtures$|leaseholdimprovements$|otherfixedassets$|depletableassets$)/;
function isFixedAsset(a: PfAccount): boolean {
  if (isAccumDep(a) || /accum|\bland\b/i.test(a.name) || dt(a) === 'land') return false;
  if (FA_DETAIL.test(dt(a)) || /fixed\s*asset/.test(st(a))) return true;
  return (
    !typed(a) &&
    (a.type === null || a.type === 'ASSET') &&
    /vehicle|truck|trailer|equipment|machinery|furniture|fixtures|building|leasehold|computer|\btools?\b/i.test(a.name) &&
    !/deposit|prepaid|inventory/i.test(a.name)
  );
}
const isSalesTax = (a: PfAccount): boolean => dt(a) === 'salestaxpayable' || (liabilityish(a) && /sales\s+tax/i.test(a.name));
function isPayrollLiability(a: PfAccount): boolean {
  if (/^payroll/.test(dt(a)) && !plish(a)) return true;
  return (
    liabilityish(a) &&
    /payroll.*(liabilit|payable|withh|accrued)|withholding|\b(fica|futa|suta|sui)\b.*payable|accrued\s+(wages|payroll)/i.test(a.name)
  );
}
const isDeferredRevenue = (a: PfAccount): boolean =>
  ['deferredrevenue', 'unearnedrevenue'].includes(dt(a)) || (liabilityish(a) && /deferred\s+revenue|unearned\s+(revenue|income)/i.test(a.name));
const isCustomerDepositLiability = (a: PfAccount): boolean =>
  liabilityish(a) && !plish(a) && /customer\s+deposits?|deposits?\s+(from|received|held)|retainers?\s+(held|received)|client\s+retainers?/i.test(a.name);
const isRevenue = (a: PfAccount): boolean => {
  if (a.sourceType) return /income|revenue|sales/.test(st(a)) && !/liabilit|asset/.test(st(a));
  return a.type === 'REVENUE';
};
const isBillingsInExcess = (a: PfAccount): boolean => /billings?\s+in\s+excess|contract\s+liabilit|overbill/i.test(a.name);
const isUnbilled = (a: PfAccount): boolean =>
  /unbilled|costs?\s+(and\s+estimated\s+earnings\s+)?in\s+excess|underbill|contract\s+asset/i.test(a.name);
const isWip = (a: PfAccount): boolean =>
  assetish(a) && !plish(a) && !isUnbilled(a) && !isBillingsInExcess(a) && /work\s+in\s+(progress|process)|\bwip\b/i.test(a.name);
const LOAN_DETAIL = new Set(['notespayable', 'loanpayable', 'lineofcredit', 'shareholdernotespayable']);
const isLoan = (a: PfAccount): boolean =>
  !isDueToFrom(a) &&
  liabilityish(a) &&
  (LOAN_DETAIL.has(dt(a)) || /\bloans?\b|notes?\s+payable|line\s+of\s+credit|\bloc\b|mortgage/i.test(a.name));

// ── Context shared by every check ───────────────────────────────────────────────

interface Ctx {
  input: PreflightInput;
  /** "as of Sep 30, 2026" / "as of your cutover date". */
  at: string;
  /** "Sep 30, 2026" / "your cutover date". */
  on: string;
  tb: boolean;
  accounts: PfAccount[];
  noTb: Body;
}

function makeCtx(input: PreflightInput): Ctx {
  const on = input.asOf ? longDate(input.asOf) : 'your cutover date';
  const at = `as of ${on}`;
  const tb = input.tbAvailable && input.accounts.length > 0;
  return {
    input,
    at,
    on,
    tb,
    accounts: input.accounts,
    noTb: na(
      'Waiting for the trial balance',
      `Drop the trial balance ${at} (or connect the ledger) to run this check. It reads account balances at cutover.`,
      `Drop the trial balance ${at}, or connect the ledger.`,
    ),
  };
}

const itemLine = (i: PfOpenItem): string => `${i.docNumber} · ${i.party} · ${dollars(i.balanceCents)}`;

/** Unapplied (negative) items first — the usual cause — then the largest. */
function itemSample(items: readonly PfOpenItem[]): string[] {
  return [...items]
    .sort((a, b) => (a.balanceCents < 0 ? 0 : 1) - (b.balanceCents < 0 ? 0 : 1) || Math.abs(b.balanceCents) - Math.abs(a.balanceCents))
    .slice(0, 5)
    .map(itemLine);
}

// ── PF-01 / PF-02 — control ties ────────────────────────────────────────────────

function controlTie(ctx: Ctx, side: 'ar' | 'ap'): Body {
  const ar = side === 'ar';
  const items = ar ? ctx.input.openInvoices : ctx.input.openBills;
  const report = ar ? 'A/R aging report' : 'A/P aging report';
  if (items === null) {
    return na(
      `Waiting for the ${report}`,
      `Drop the ${report} ${ctx.at} to run this check. It ties every open ${ar ? 'invoice' : 'bill'} to the ${ar ? 'A/R' : 'A/P'} account.`,
      `Drop the ${report} ${ctx.at}.`,
    );
  }
  if (!ctx.tb) return ctx.noTb;
  const ctrl = ctx.accounts.filter(ar ? isAR : isAP);
  // Debit-positive: A/R is positive; A/P is a credit, so flip it to "amount owed".
  const ctrlTotal = ar ? sumBal(ctrl) : -sumBal(ctrl);
  const agingTotal = sum(items.map((i) => i.balanceCents));
  const diff = ctrlTotal - agingTotal;
  const acct = ar ? 'A/R account (money customers owe you)' : 'A/P account (money you owe vendors)';
  const short = ar ? 'A/R' : 'A/P';
  if (ctrl.length === 0 && agingTotal === 0) {
    return na(
      ar ? 'No receivables in these books' : 'No payables in these books',
      `There’s no ${short} account in the chart and no open ${ar ? 'invoices' : 'bills'} ${ctx.at}.`,
      'Nothing to do.',
    );
  }
  if (diff === 0) {
    return pass(
      ar ? 'Receivables match the A/R account to the cent' : 'Payables match the A/P account to the cent',
      `Your ${ar ? 'receivables' : 'payables'} aging and the ${acct} both show ${dollars(ctrlTotal)} ${ctx.at}.`,
      { accounts: labels(ctrl), count: items.length },
    );
  }
  const gap = Math.abs(diff);
  const docWord = ar ? 'invoice' : 'bill';
  const cause =
    ctrl.length === 0
      ? `There’s no ${short} account in the chart, so the whole aging has nowhere to land.`
      : diff > 0
        ? `That money sits in ${short} with no ${docWord} behind it, so nobody can ${ar ? 'collect' : 'pay'} it. It usually comes from journal entries posted straight to ${short}${ar ? '' : ', or a bill payment recorded twice'}.`
        : `The aging shows ${dollars(gap)} more than the ${short} account. That usually means ${ar ? 'customer payments or credits' : 'bill payments or vendor credits'} recorded outside ${short}, or a journal entry that reduced ${short} directly.`;
  return body({
    severity: 'blocker',
    title: ar ? 'Receivables don’t match the A/R account' : 'Payables don’t match the A/P account',
    message: `Your ${ar ? 'receivables' : 'payables'} aging adds to ${dollars(agingTotal)}, but the ${acct} says ${dollars(ctrlTotal)} ${ctx.at}, a ${dollars(gap)} gap. ${cause}`,
    fix: `Fix it in the source (apply or reverse the entries, then re-pull and this check re-runs), or have it handled here: carry ${dollars(gap)} as one reconciling item, “Unapplied ${short} from conversion”, cleared in the first month.`,
    amountCents: gap,
    accounts: labels(ctrl),
    sample: itemSample(items),
    count: items.length,
  });
}

// ── PF-03..PF-06 — suspense-type balances ───────────────────────────────────────

interface SuspenseSpec {
  match: (a: PfAccount) => boolean;
  passTitle: string;
  passMessage: string;
  failTitle: (total: number, names: string[]) => string;
  failMessage: (total: number, names: string[], at: string) => string;
  fix: string;
}

function suspenseCheck(ctx: Ctx, spec: SuspenseSpec): Body {
  if (!ctx.tb) return ctx.noTb;
  const hits = nonZero(ctx.accounts.filter(spec.match));
  if (hits.length === 0) return pass(spec.passTitle, spec.passMessage.replace('{at}', ctx.at));
  const total = sumAbs(hits);
  const names = hits.map((a) => a.name);
  return body({
    severity: 'warning',
    title: spec.failTitle(total, names),
    message: spec.failMessage(total, names, ctx.at),
    fix: spec.fix,
    amountCents: total,
    accounts: labels(hits),
    sample: hits.map((a) => `${label(a)} · ${dollars(a.balanceCents)}`),
    count: hits.length,
  });
}

const pf03 = (ctx: Ctx): Body =>
  suspenseCheck(ctx, {
    match: isUndeposited,
    passTitle: 'Undeposited Funds is empty',
    passMessage: 'Every payment received has been matched to a bank deposit {at}.',
    failTitle: (t) => `Undeposited Funds holds ${dollars(t)}`,
    failMessage: (t, _n, at) =>
      `${dollars(t)} sits in Undeposited Funds ${at}. That’s the holding account for payments recorded as received but never matched to a bank deposit. If those deposits already hit the bank, the money is probably counted twice.`,
    fix: 'Match the payments to their deposits in the source before cutover, or carry the balance over and clear it in the first month.',
  });

const pf04 = (ctx: Ctx): Body =>
  suspenseCheck(ctx, {
    match: isUncategorized,
    passTitle: 'Nothing left uncategorized',
    passMessage: 'No uncategorized income, expense or asset balances {at}.',
    failTitle: (t, n) => (n.length === 1 ? `${n[0]} holds ${dollars(t)}` : `${dollars(t)} was never categorized`),
    failMessage: (t, n, at) =>
      `${dollars(t)} is sitting in ${list(n)} ${at}. These are transactions nobody put in a real category, so profit and balances are off by up to that much.`,
    fix: 'Categorize them in the source first, or bring them over to a review queue and sort them here.',
  });

const pf05 = (ctx: Ctx): Body =>
  suspenseCheck(ctx, {
    match: isSuspense,
    passTitle: 'Nothing parked in Ask My Accountant or suspense',
    passMessage: 'No balances waiting in Ask My Accountant or a suspense account {at}.',
    failTitle: (t, n) => (n.length === 1 ? `${n[0]} holds ${dollars(t)}` : `${dollars(t)} parked in suspense accounts`),
    failMessage: (t, n, at) =>
      `${dollars(t)} is parked in ${list(n)} ${at}. Those are transactions someone wasn’t sure how to record (a suspense account is a temporary holding place).`,
    fix: 'Resolve them with the accountant in the source, or bring them over to a review queue so they don’t become an opening balance.',
  });

const pf06 = (ctx: Ctx): Body =>
  suspenseCheck(ctx, {
    match: isOBE,
    passTitle: 'Opening Balance Equity is zero',
    passMessage: 'Opening Balance Equity is zero {at}, as it is in clean books.',
    failTitle: (t) => `Opening Balance Equity holds ${dollars(t)}`,
    failMessage: (t, _n, at) =>
      `Opening Balance Equity shows ${dollars(t)} ${at}. QuickBooks-style ledgers put starting balances here when accounts are set up; in clean books it has been moved to retained earnings or owner’s equity and is zero.`,
    fix: 'Reclass it to retained earnings or owner’s equity. We’ll propose the entry; a controller approves it.',
  });

// ── PF-07 — trial balance balances ──────────────────────────────────────────────

function pf07(ctx: Ctx): Body {
  if (!ctx.tb) return ctx.noTb;
  const debits = sum(ctx.accounts.map((a) => Math.max(a.balanceCents, 0)));
  const credits = sum(ctx.accounts.map((a) => Math.max(-a.balanceCents, 0)));
  const diff = debits - credits;
  const n = ctx.accounts.length;
  if (diff === 0) {
    return pass('Debits equal credits', `Debits and credits both total ${dollars(debits)} across ${plural(n, 'account')} ${ctx.at}.`, { count: n });
  }
  const off = [...ctx.accounts].sort((a, b) => Math.abs(b.balanceCents) - Math.abs(a.balanceCents));
  return body({
    severity: 'blocker',
    title: `The trial balance is off by ${dollars(Math.abs(diff))}`,
    message: `Debits total ${dollars(debits)} but credits total ${dollars(credits)} ${ctx.at}. A trial balance (every account’s balance on one page) must net to zero; this usually means the export was cut off, filtered, or run on a different basis.`,
    fix: `Re-pull the trial balance ${ctx.at}, or rebuild it from the general ledger detail.`,
    amountCents: Math.abs(diff),
    sample: off.slice(0, 5).map((a) => `${label(a)} · ${dollars(a.balanceCents)}`),
    count: n,
  });
}

// ── PF-08 — retained earnings roll ──────────────────────────────────────────────

function pf08(ctx: Ctx): Body {
  const py = ctx.input.priorYear;
  if (py === null) {
    return na(
      'Waiting for last year’s year-end numbers',
      'Drop last year’s year-end balance sheet and profit and loss to run this check. It confirms last year’s profit was closed into retained earnings.',
      'Drop last year’s year-end balance sheet and profit and loss.',
    );
  }
  if (!ctx.tb) return ctx.noTb;
  const re = ctx.accounts.filter(isRE);
  const expected = py.retainedEarningsCents + py.netIncomeCents;
  const actual = -sumBal(re); // credit-positive
  const diff = actual - expected;
  const roll = `${dollars(py.retainedEarningsCents)} of retained earnings plus last year’s ${py.netIncomeCents < 0 ? 'loss' : 'net income'} of ${dollars(Math.abs(py.netIncomeCents))}`;
  if (diff === 0) {
    return pass('Retained earnings rolls forward to the cent', `${roll} gives ${dollars(expected)}, exactly what retained earnings shows ${ctx.at}.`, {
      accounts: labels(re),
    });
  }
  return body({
    severity: 'blocker',
    title: `Retained earnings is off by ${dollars(Math.abs(diff))}`,
    message: `${roll} should give ${dollars(expected)} of retained earnings (the profit kept in the business over the years), but ${re.length ? `the books show ${dollars(actual)}` : 'there’s no retained earnings account in the chart'} ${ctx.at}. Last year wasn’t closed cleanly, or entries were posted straight to retained earnings.`,
    fix: 'Let MeritBooks run the year-end close on the history it imports, or correct the entries in the source and re-pull.',
    amountCents: Math.abs(diff),
    accounts: labels(re),
  });
}

// ── PF-09 — abnormal signs ──────────────────────────────────────────────────────

function pf09(ctx: Ctx): Body {
  if (!ctx.tb) return ctx.noTb;
  const lines: string[] = [];
  const brief: string[] = [];
  const accts: string[] = [];
  let total = 0;
  const flag = (a: PfAccount, why: string): void => {
    lines.push(`${label(a)} · ${dollars(a.balanceCents)} · ${why}`);
    brief.push(`${a.name} (${why})`);
    accts.push(label(a));
    total += Math.abs(a.balanceCents);
  };
  for (const a of ctx.accounts) {
    if (a.balanceCents === 0) continue;
    if (isBank(a) && a.balanceCents < 0) flag(a, 'bank account below zero');
    else if (isAR(a) && a.balanceCents < 0) flag(a, 'customers owed money overall');
    else if (isAP(a) && a.balanceCents > 0) flag(a, 'vendors owe you overall');
    else if (isInventory(a) && a.balanceCents < 0) flag(a, 'negative inventory');
    else if ((isDeferredRevenue(a) || isCustomerDepositLiability(a) || isBillingsInExcess(a)) && a.balanceCents > 0)
      flag(a, 'deposit or deferred revenue on the wrong side');
  }
  // Party-level: a vendor you overpaid (net debit) or a customer you owe (net credit).
  const partyNet = (items: PfOpenItem[] | null): Array<[string, number]> => {
    const m = new Map<string, number>();
    for (const i of items ?? []) m.set(i.party, (m.get(i.party) ?? 0) + i.balanceCents);
    return [...m.entries()].filter(([, v]) => v < 0);
  };
  const vendors = partyNet(ctx.input.openBills);
  const customers = partyNet(ctx.input.openInvoices);
  for (const [p, v] of vendors) {
    lines.push(`${p} · ${dollars(-v)} · vendor overpaid`);
    brief.push(`${p} (vendor overpaid)`);
    total += -v;
  }
  for (const [p, v] of customers) {
    lines.push(`${p} · ${dollars(-v)} · customer credit balance`);
    brief.push(`${p} (customer credit balance)`);
    total += -v;
  }
  if (lines.length === 0) {
    return pass('Every balance sits on its normal side', `No overdrawn cash, debit payables, negative inventory, wrong-side deposits, overpaid vendors or customer credits ${ctx.at}.`);
  }
  const title =
    lines.length === 1 && vendors.length === 1
      ? `Debit balance on a vendor: ${vendors[0][0]}`
      : lines.length === 1 && customers.length === 1
        ? `Credit balance on a customer: ${customers[0][0]}`
        : `${plural(lines.length, 'balance')} on the wrong side`;
  return body({
    severity: 'warning',
    title,
    message: `${dollars(total)} sits on the unusual side ${ctx.at}: ${shortList(brief)}. An abnormal sign (an account carrying the opposite of its normal balance) usually means an overpayment, a deposit recorded the wrong way, or a missing entry.`,
    fix: 'Explain each one (an overpaid vendor can stay as a credit to use), or reclass it in the source before cutover.',
    amountCents: total,
    accounts: accts,
    sample: lines,
    count: lines.length,
  });
}

// ── PF-10 — bank reconciliations ────────────────────────────────────────────────

function pf10(ctx: Ctx): Body {
  const bank = ctx.input.bank;
  if (bank === null) {
    return na(
      'Waiting for the bank reconciliations',
      'Connect the bank feed or drop the last bank reconciliation report for each account to run this check.',
      'Connect the bank feed, or drop the last reconciliation report for each bank account.',
    );
  }
  if (bank.length === 0) return na('No bank accounts', 'No bank accounts were found for this client.', 'Nothing to do.');
  const asOf = ctx.input.asOf;
  if (!asOf) return na('Waiting for the cutover date', 'Set the cutover date to run this check; it measures how far reconciliations lag it.', 'Set the cutover date in the plan.');
  let blocker = false;
  let amount = 0;
  const lines: string[] = [];
  const flagged: string[] = [];
  for (const b of bank) {
    const reasons: string[] = [];
    let bad = false;
    if (b.lastReconciledDate === null) {
      reasons.push('no reconciliation on record');
      bad = true;
    } else {
      const lag = daysBetween(b.lastReconciledDate, asOf);
      if (lag > 60) {
        reasons.push(`last reconciled ${longDate(b.lastReconciledDate)}, ${lag} days before cutover`);
        bad = true;
        if (lag > 180) blocker = true;
      }
    }
    if (b.oldestUnclearedDate) {
      const age = daysBetween(b.oldestUnclearedDate, asOf);
      if (age > 90) {
        reasons.push(`uncleared items back to ${longDate(b.oldestUnclearedDate)}`);
        bad = true;
        if (age > 180) blocker = true;
      }
    }
    if (bad) {
      flagged.push(b.label);
      amount += Math.abs(b.unclearedTotalCents);
      const unc = b.unclearedTotalCents !== 0 ? ` · ${dollars(b.unclearedTotalCents)} uncleared` : '';
      lines.push(`${b.label} · ${reasons.join('; ')}${unc}`);
    }
  }
  if (flagged.length === 0) {
    return pass('Every bank account is reconciled', `All ${plural(bank.length, 'bank account')} were reconciled within 60 days of ${ctx.on}, with no uncleared items older than 90 days.`, {
      count: bank.length,
    });
  }
  const one = flagged.length === 1 ? bank.find((b) => b.label === flagged[0]) : undefined;
  const title =
    one && one.lastReconciledDate
      ? `${one.label} last reconciled ${longDate(one.lastReconciledDate)}`
      : `${plural(flagged.length, 'bank account')} not reconciled recently`;
  return body({
    severity: blocker ? 'blocker' : 'warning',
    title,
    message: `${list(flagged)} ${flagged.length === 1 ? 'hasn’t' : 'haven’t'} been reconciled (matched line by line to the bank statement) close enough to ${ctx.on}${amount ? `, with ${dollars(amount)} of uncleared items` : ''}. Until it is, the opening cash balance can’t be trusted.${blocker ? ' More than 180 days out, this stops Prove balances.' : ''}`,
    fix: 'Reconcile through cutover in the source, or import the last reconciliation’s outstanding items so they clear here.',
    amountCents: amount,
    sample: lines,
    count: flagged.length,
  });
}

// ── PF-11 — closed-period edits ─────────────────────────────────────────────────

function pf11(ctx: Ctx): Body {
  const { booksClosedThrough, sourceChangedSincePull } = ctx.input;
  const edits = ctx.input.evidence.filter((e) => e.kind === 'books_closed' && e.amountCents !== null && e.amountCents !== 0);
  if (!sourceChangedSincePull && edits.length === 0 && booksClosedThrough === null) {
    return na(
      'Waiting for the books-closed date',
      'Tell us the date the books are closed through (the source’s closing date, or the last period the accountant signed off) to run this check.',
      'Set the books-closed date, or connect the ledger so we can read its closing date.',
    );
  }
  if (!sourceChangedSincePull && edits.length === 0) {
    return pass('No edits to closed periods', `The books are closed through ${longDate(booksClosedThrough)}, and nothing dated on or before it changed.`);
  }
  const amount = sum(edits.map((e) => Math.abs(e.amountCents ?? 0)));
  const parts: string[] = [];
  if (edits.length) {
    parts.push(
      `${plural(edits.length, 'change')} worth ${dollars(amount)} ${edits.length === 1 ? 'is' : 'are'} dated inside a period that was already closed${booksClosedThrough ? ` (through ${longDate(booksClosedThrough)})` : ''}`,
    );
  }
  if (sourceChangedSincePull) parts.push('the source changed after we pulled it, so what we checked may no longer match');
  return body({
    severity: 'warning',
    title: edits.length ? 'Someone changed a closed period' : 'The source changed after we pulled it',
    message: `${parts.join('; and ')}. Numbers your accountant already signed off may have moved.`.replace(/^./, (c) => c.toUpperCase()),
    fix: 'Re-pull so the checks run on the current numbers, or accept the changes with a note.',
    amountCents: amount,
    sample: edits.map((e) => `${e.label}${e.asOf ? ` · ${longDate(e.asOf)}` : ''} · ${dollars(e.amountCents ?? 0)}`),
    count: edits.length + (sourceChangedSincePull ? 1 : 0),
  });
}

// ── PF-12 — inactive accounts with balances ─────────────────────────────────────

function pf12(ctx: Ctx): Body {
  if (!ctx.tb) return ctx.noTb;
  const hits = nonZero(ctx.accounts.filter((a) => !a.active));
  if (hits.length === 0) return pass('No inactive accounts carry a balance', `Every account with a balance ${ctx.at} is active.`);
  const total = sumAbs(hits);
  return body({
    severity: 'warning',
    title: `${plural(hits.length, 'inactive account')} still ${hits.length === 1 ? 'carries' : 'carry'} ${dollars(total)}`,
    message: `${shortList(hits.map((a) => a.name))} ${hits.length === 1 ? 'is' : 'are'} marked inactive but still ${hits.length === 1 ? 'has' : 'have'} a balance ${ctx.at}. Inactive accounts disappear from most source reports, so these balances are easy to miss.`,
    fix: 'Map them anyway (they’re shown in Match accounts), or clear the balances in the source.',
    amountCents: total,
    accounts: labels(hits),
    sample: hits.map((a) => `${label(a)} · ${dollars(a.balanceCents)}`),
    count: hits.length,
  });
}

// ── PF-13 — duplicate customers / vendors ───────────────────────────────────────

function duplicateGroups(parties: readonly PfParty[]): string[][] {
  const parent = parties.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const seen = new Map<string, number>();
  const link = (k: string | null, i: number): void => {
    if (!k) return;
    const j = seen.get(k);
    if (j === undefined) seen.set(k, i);
    else parent[find(i)] = find(j);
  };
  parties.forEach((p, i) => {
    const n = normalizeName(p.name);
    link(n ? `n:${n}` : null, i);
    const email = (p.email ?? '').trim().toLowerCase();
    link(email.includes('@') ? `e:${email}` : null, i);
    let phone = (p.phone ?? '').replace(/\D/g, '');
    if (phone.length === 11 && phone.startsWith('1')) phone = phone.slice(1);
    link(phone.length >= 10 ? `p:${phone.slice(-10)}` : null, i);
    link(p.taxIdHash ? `t:${p.taxIdHash}` : null, i);
  });
  const groups = new Map<number, string[]>();
  parties.forEach((p, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), p.name]);
  });
  return [...groups.values()].filter((g) => g.length > 1);
}

function pf13(ctx: Ctx): Body {
  const { customers, vendors } = ctx.input;
  if (customers === null && vendors === null) {
    return na('Waiting for the customer and vendor lists', 'Drop the customer and vendor lists to run this check.', 'Drop the customer and vendor lists, or connect the ledger.');
  }
  const cg = duplicateGroups(customers ?? []);
  const vg = duplicateGroups(vendors ?? []);
  const merges = (gs: string[][]): number => sum(gs.map((g) => g.length - 1));
  const n = merges(cg) + merges(vg);
  const missing = customers === null ? ' The customer list hasn’t been dropped yet.' : vendors === null ? ' The vendor list hasn’t been dropped yet.' : '';
  if (n === 0) return pass('No duplicate customers or vendors', `No two records share a name, email, phone or tax ID.${missing}`);
  const kinds = cg.length && vg.length ? ['customer or vendor', 'customers and vendors'] : cg.length ? ['customer', 'customers'] : ['vendor', 'vendors'];
  const sample = [...cg, ...vg].map((g) => g.join(' ↔ '));
  const first = [...cg, ...vg][0];
  return body({
    severity: 'info',
    title: n === 1 ? `1 likely duplicate ${kinds[0]}` : `${n} likely duplicate ${kinds[1]}`,
    message: `“${first[0]}” and “${first[1]}”${n > 1 ? `, and ${n - 1} more` : ''}. They match on name (ignoring Inc, LLC, Co and punctuation), email, phone or tax ID. They become merge proposals when you match accounts.${missing}`,
    fix: 'Review the merge proposals in Match accounts; nothing merges without your approval.',
    sample,
    count: n,
  });
}

// ── PF-14 — 1099 vendors without a TIN ──────────────────────────────────────────

function pf14(ctx: Ctx): Body {
  const vendors = ctx.input.vendors;
  if (vendors === null) {
    return na('Waiting for the vendor list', 'Drop the vendor list (with 1099 flags, tax IDs and payments this year) to run this check.', 'Drop the vendor list, or connect the ledger.');
  }
  const threshold = form1099ThresholdCents(ctx.input.asOf);
  const hits = vendors.filter((v) => v.is1099 && v.ytdPaidCents >= threshold && !v.hasTaxId);
  const eligible = vendors.filter((v) => v.is1099 && v.ytdPaidCents >= threshold).length;
  if (hits.length === 0) {
    return pass(
      '1099 vendors all have a tax ID',
      eligible
        ? `All ${plural(eligible, '1099 vendor')} paid ${wholeDollars(threshold)} or more this year have a tax ID on file.`
        : `No 1099 vendor has been paid ${wholeDollars(threshold)} or more this year without a tax ID.`,
    );
  }
  const total = sum(hits.map((v) => v.ytdPaidCents));
  return body({
    severity: 'warning',
    title: `${plural(hits.length, 'vendor')} paid ${wholeDollars(threshold)}+ ${hits.length === 1 ? 'has' : 'have'} no tax ID`,
    message: `${shortList(hits.map((v) => v.name), 4)} ${hits.length === 1 ? 'was' : 'were'} paid ${dollars(total)} this year and ${hits.length === 1 ? 'is' : 'are'} flagged for a 1099, but there’s no tax ID (TIN, from a W-9 form) on file. You can’t file their 1099s in January without one.`,
    fix: 'Send each a secure W-9 request through the vendor portal; the tax ID fills in when they answer.',
    amountCents: total,
    sample: hits.map((v) => `${v.name} · ${dollars(v.ytdPaidCents)}`),
    count: hits.length,
  });
}

// ── PF-15 — sales tax ───────────────────────────────────────────────────────────

const evidenceOf = (ctx: Ctx, kind: PfEvidence['kind']): PfEvidence[] => ctx.input.evidence.filter((e) => e.kind === kind);

function pf15(ctx: Ctx): Body {
  if (!ctx.tb) return ctx.noTb;
  const accts = ctx.accounts.filter(isSalesTax);
  const ev = evidenceOf(ctx, 'sales_tax').filter((e) => e.amountCents !== null);
  const gl = -sumBal(accts); // credit-positive liability
  if (ev.length === 0) {
    if (accts.length === 0) return na('No sales tax in these books', 'There’s no sales tax account and no sales-tax return on file.', 'Nothing to do.');
    return na(
      'Waiting for the sales-tax return',
      `Drop the last sales-tax return and the collections since it to run this check. The books show ${dollars(gl)} of sales tax owed ${ctx.at}.`,
      'Drop the last filed sales-tax return and the sales-tax collected report since it.',
    );
  }
  const expected = sum(ev.map((e) => e.amountCents ?? 0));
  const diff = gl - expected;
  const support = ev.map((e) => `${e.label}${e.asOf ? ` · ${longDate(e.asOf)}` : ''} · ${dollars(e.amountCents ?? 0)}`);
  if (diff === 0) {
    return pass('Sales tax ties to the return', `The last return plus collections since come to ${dollars(expected)}, the same as the sales tax owed in the books ${ctx.at}.`, {
      accounts: labels(accts),
      sample: support,
    });
  }
  return body({
    severity: 'warning',
    title: `Sales tax owed is off by ${dollars(Math.abs(diff))}`,
    message: `The last return plus collections since come to ${dollars(expected)}, but the books show ${dollars(gl)} of sales tax owed ${ctx.at}. The difference is usually a payment or adjustment recorded to the wrong account.`,
    fix: 'Carry the difference over and note it on the tax calendar, or correct it in the source first.',
    amountCents: Math.abs(diff),
    accounts: labels(accts),
    sample: support,
    count: ev.length,
  });
}

// ── PF-16 — payroll liabilities aged ────────────────────────────────────────────

function pf16(ctx: Ctx): Body {
  const ev = evidenceOf(ctx, 'payroll_liability');
  if (!ctx.tb && ev.length === 0) return ctx.noTb;
  const accts = ctx.tb ? nonZero(ctx.accounts.filter(isPayrollLiability)) : [];
  const anyPayroll = ctx.tb && ctx.accounts.some(isPayrollLiability);
  if (!anyPayroll && ev.length === 0) return na('No payroll liabilities in these books', 'There’s no payroll liability account and no payroll report on file.', 'Nothing to do.');
  const asOf = ctx.input.asOf;
  if (ev.length === 0) {
    if (accts.length === 0) return pass('Payroll liabilities are clear', `Payroll liability accounts are at zero ${ctx.at}.`);
    const total = sumAbs(accts);
    return body({
      severity: 'warning',
      title: `${dollars(total)} of payroll liabilities with no proof of payment`,
      message: `${list(accts.map((a) => a.name))} ${accts.length === 1 ? 'shows' : 'show'} ${dollars(total)} owed ${ctx.at} (payroll taxes and withholdings not yet sent to the government or plan), and there’s no payroll report to show when it was paid.`,
      fix: 'Drop the latest payroll liability report or tax deposit confirmations so we can verify it was remitted.',
      amountCents: total,
      accounts: labels(accts),
      sample: accts.map((a) => `${label(a)} · ${dollars(a.balanceCents)}`),
      count: accts.length,
    });
  }
  if (!asOf) return na('Waiting for the cutover date', 'Set the cutover date to run this check; it ages payroll liabilities against it.', 'Set the cutover date in the plan.');
  const aged = ev.filter((e) => e.asOf !== null && daysBetween(e.asOf, asOf) > 30 && (e.amountCents ?? 0) !== 0);
  if (aged.length === 0) {
    return pass('Payroll liabilities are current', `Nothing on the payroll liability report is more than 30 days old ${ctx.at}.`, { accounts: labels(accts) });
  }
  const total = sum(aged.map((e) => Math.abs(e.amountCents ?? 0)));
  return body({
    severity: 'warning',
    title: `${dollars(total)} of payroll liabilities more than 30 days old`,
    message: `${shortList(aged.map((e) => e.label))} ${aged.length === 1 ? 'has' : 'have'} been owed for more than 30 days ${ctx.at}. Payroll taxes are normally sent within days; an old balance means a missed deposit or a payment booked somewhere else.`,
    fix: 'Verify the remittance with the payroll provider, then clear it in the source or carry it with a note.',
    amountCents: total,
    accounts: labels(accts),
    sample: aged.map((e) => `${e.label} · ${longDate(e.asOf)} · ${dollars(e.amountCents ?? 0)}`),
    count: aged.length,
  });
}

// ── PF-17 — fixed assets / depreciation ─────────────────────────────────────────

function pf17(ctx: Ctx): Body {
  if (!ctx.tb) return ctx.noTb;
  const fa = nonZero(ctx.accounts.filter(isFixedAsset));
  if (fa.length === 0) return na('No fixed assets in these books', 'There are no vehicles, equipment or other depreciable assets with a balance.', 'Nothing to do.');
  const ad = ctx.accounts.filter(isAccumDep);
  const faTotal = sumBal(fa);
  const adTotal = sumBal(ad);
  const ev = evidenceOf(ctx, 'depreciation').filter((e) => e.asOf !== null);
  const asOf = ctx.input.asOf;
  if (adTotal === 0) {
    return body({
      severity: 'warning',
      title: 'Fixed assets with no depreciation',
      message: `${list(fa.map((a) => a.name))} ${fa.length === 1 ? 'carries' : 'carry'} ${dollars(faTotal)} ${ctx.at}, but no accumulated depreciation (the running total of wear written off) has ever been recorded against them.`,
      fix: 'Accept a catch-up depreciation proposal from the schedule card, or drop the depreciation schedule from the tax preparer.',
      amountCents: Math.abs(faTotal),
      accounts: labels(fa),
      sample: fa.map((a) => `${label(a)} · ${dollars(a.balanceCents)}`),
      count: fa.length,
    });
  }
  const last = ev
    .map((e) => e.asOf)
    .filter((d): d is string => d !== null)
    .sort()
    .pop();
  if (last && asOf && daysBetween(last, asOf) > 60) {
    const latest = ev.filter((e) => e.asOf === last);
    const catchUp = sum(latest.map((e) => Math.abs(e.amountCents ?? 0)));
    const note = latest.map((e) => e.note).filter((n): n is string => !!n);
    return body({
      severity: 'warning',
      title: `Depreciation not run since ${longDate(last)}`,
      message: `Depreciation was last recorded ${longDate(last)}, ${daysBetween(last, asOf)} days before cutover${catchUp ? `; the catch-up is about ${dollars(catchUp)}` : ''}${note.length ? ` (${note.join('; ')})` : ''}. Until it’s caught up, assets are overstated and profit is too high.`,
      fix: 'Accept the catch-up depreciation proposal (posted on the schedule card), or run it in the source before cutover.',
      amountCents: catchUp,
      accounts: labels([...fa, ...ad]),
      sample: latest.map((e) => `${e.label} · ${longDate(e.asOf)}${e.amountCents ? ` · ${dollars(e.amountCents)}` : ''}`),
      count: fa.length,
    });
  }
  return pass(
    'Depreciation is up to date',
    last
      ? `Depreciation was last recorded ${longDate(last)}, within 60 days of cutover, against ${dollars(faTotal)} of fixed assets.`
      : `${dollars(faTotal)} of fixed assets carry ${dollars(-adTotal)} of accumulated depreciation. Drop the depreciation schedule to also confirm when it was last run.`,
    { accounts: labels([...fa, ...ad]) },
  );
}

// ── PF-18 — deposits / retainers in revenue ─────────────────────────────────────

function pf18(ctx: Ctx): Body {
  if (!ctx.tb) return ctx.noTb;
  const hits = nonZero(ctx.accounts.filter((a) => isRevenue(a) && /deposit|retainer/i.test(a.name)));
  if (hits.length === 0) return pass('No deposits booked as revenue', `No revenue account holds customer deposits or retainers ${ctx.at}.`);
  const total = sumAbs(hits);
  return body({
    severity: 'warning',
    title: hits.length === 1 ? `${hits[0].name} booked as revenue` : 'Customer deposits booked as revenue',
    message: `${dollars(total)} of customer deposits or retainers sits in ${list(hits.map((a) => a.name))}, a revenue account, ${ctx.at}. Money taken before the work is done is owed back to the customer until it’s earned, so it belongs in a customer deposits liability.`,
    fix: 'Reclass it to customer deposits (2420); it moves to revenue as the jobs complete.',
    amountCents: total,
    accounts: labels(hits),
    sample: hits.map((a) => `${label(a)} · ${dollars(a.balanceCents)}`),
    count: hits.length,
  });
}

// ── PF-19 — retainage folded into trade AR/AP ───────────────────────────────────

const RETAINAGE_TEXT = /retainage|retention|\bret\b/i;

function pf19(ctx: Ctx): Body {
  const retAccts = ctx.accounts.filter(isRetainage);
  if (retAccts.length > 0) {
    return pass('Retainage is kept in its own accounts', `${list(retAccts.map((a) => a.name))} ${retAccts.length === 1 ? 'holds' : 'hold'} retainage separately from trade receivables and payables.`, {
      accounts: labels(retAccts),
    });
  }
  const items = [...(ctx.input.openInvoices ?? []), ...(ctx.input.openBills ?? [])].filter((i) => RETAINAGE_TEXT.test(i.docNumber));
  const ev = ctx.input.evidence.filter((e) => RETAINAGE_TEXT.test(e.label) || RETAINAGE_TEXT.test(e.note ?? ''));
  if (items.length === 0 && ev.length === 0) {
    const noItems = ctx.input.openInvoices === null && ctx.input.openBills === null;
    return na(
      'No retainage in use',
      noItems
        ? 'There are no retainage accounts. Drop the A/R and A/P aging to also check for retainage held inside open invoices and bills.'
        : 'There are no retainage accounts and nothing on the open invoices or bills is marked as retainage.',
      noItems ? 'Drop the A/R and A/P aging reports.' : 'Nothing to do.',
    );
  }
  const total = sum(items.map((i) => Math.abs(i.balanceCents)));
  return body({
    severity: 'warning',
    title: 'Retainage mixed into trade receivables and payables',
    message: `${items.length ? `${plural(items.length, 'open item')} worth ${dollars(total)} ${items.length === 1 ? 'is' : 'are'} marked as retainage` : 'Retainage shows up in the documents on file'}, but there are no retainage accounts, so it’s folded into regular A/R and A/P. Retainage (the share of a contract held back until the job is accepted) isn’t due on normal terms and has to be tracked apart.`,
    fix: 'Split it to retainage receivable and retainage payable accounts when you match accounts.',
    amountCents: total,
    sample: [...items.map(itemLine), ...ev.map((e) => e.label)],
    count: items.length + ev.length,
  });
}

// ── PF-20 — WIP schedule vs GL ──────────────────────────────────────────────────

function pf20(ctx: Ctx): Body {
  const jobs = ctx.input.jobs;
  if (jobs === null) {
    return na(
      'Waiting for the WIP schedule',
      'Drop the WIP schedule (cost, billed and earned to date per open job) to run this check, if this client has jobs in progress.',
      'Drop the WIP schedule, or connect the field system.',
    );
  }
  if (jobs.length === 0) return na('No WIP jobs', 'There are no open jobs on the work-in-progress schedule.', 'Nothing to do.');
  if (!ctx.tb) return ctx.noTb;
  const wip = ctx.accounts.filter(isWip);
  const unbilled = ctx.accounts.filter(isUnbilled);
  const bieNamed = ctx.accounts.filter(isBillingsInExcess);
  const bie = bieNamed.length ? bieNamed : ctx.accounts.filter(isDeferredRevenue);
  type Line = { what: string; schedule: number; gl: number; accts: PfAccount[] };
  const lines: Line[] = [];
  if (wip.length) lines.push({ what: 'Cost to date vs work in progress', schedule: sum(jobs.map((j) => j.costCents)), gl: sumBal(wip), accts: wip });
  lines.push({ what: 'Unbilled (earned, not yet billed)', schedule: sum(jobs.map((j) => j.unbilledCents)), gl: sumBal(unbilled), accts: unbilled });
  lines.push({ what: 'Billings in excess (billed ahead of the work)', schedule: sum(jobs.map((j) => j.billingsInExcessCents)), gl: -sumBal(bie), accts: bie });
  const off = lines.filter((l) => l.schedule !== l.gl);
  const allAccts = labels(lines.flatMap((l) => l.accts));
  if (off.length === 0) {
    return pass('The WIP schedule matches the books', `Across ${plural(jobs.length, 'open job')}, cost, unbilled and billings in excess on the schedule all tie to the general ledger ${ctx.at}.`, {
      accounts: allAccts,
      count: jobs.length,
    });
  }
  const amount = sum(off.map((l) => Math.abs(l.schedule - l.gl)));
  return body({
    severity: 'blocker',
    title: `The WIP schedule is off from the books by ${dollars(amount)}`,
    message: `The work-in-progress schedule (each open job’s cost, billing and earned revenue) doesn’t tie to the general ledger ${ctx.at}: ${off
      .map((l) => `${l.what.split(' (')[0].toLowerCase()} is ${dollars(l.schedule)} on the schedule but ${dollars(l.gl)} in the books`)
      .join('; ')}. Revenue recognition can’t start from the right place until it does.`,
    fix: 'Fix the schedule, or accept the true-up entry we propose so the books match it.',
    amountCents: amount,
    accounts: allAccts,
    sample: off.map((l) => `${l.what} · schedule ${dollars(l.schedule)} · books ${dollars(l.gl)}`),
    count: jobs.length,
  });
}

// ── PF-21 — loans vs lender ─────────────────────────────────────────────────────

const GENERIC_LOAN_WORDS = new Set([
  'loan', 'loans', 'note', 'notes', 'payable', 'line', 'of', 'credit', 'bank', 'term', 'na', 'n', 'a', 'and', 'to', 'from', 'long', 'short', 'current', 'portion', 'lt', 'st', 'statement', 'balance',
]);
const loanTokens = (s: string): Set<string> => new Set(normalizeName(s).split(' ').filter((t) => t.length > 1 && !GENERIC_LOAN_WORDS.has(t)));

function pf21(ctx: Ctx): Body {
  const ev = evidenceOf(ctx, 'loan').filter((e) => e.amountCents !== null);
  const loans = ctx.tb ? ctx.accounts.filter(isLoan) : [];
  if (ev.length === 0) {
    if (!ctx.tb) return ctx.noTb;
    const withBal = nonZero(loans);
    if (withBal.length === 0) return na('No loans in these books', 'There are no loans, notes or lines of credit with a balance.', 'Nothing to do.');
    return na(
      'Waiting for the lender statements',
      `Drop the lender statement ${ctx.at} for ${shortList(withBal.map((a) => a.name))} to run this check.`,
      `Drop each lender statement ${ctx.at}.`,
    );
  }
  if (!ctx.tb) return ctx.noTb;
  const byAcct = new Map<string, number>();
  const unmatched: PfEvidence[] = [];
  for (const e of ev) {
    let target = e.glAccountNumber ? ctx.accounts.find((a) => a.number === e.glAccountNumber) : undefined;
    if (!target) {
      const want = loanTokens(e.label);
      let best = 0;
      for (const a of loans) {
        const have = loanTokens(a.name);
        const score = [...want].filter((t) => have.has(t)).length;
        if (score > best) {
          best = score;
          target = a;
        }
      }
    }
    if (target) byAcct.set(target.number, (byAcct.get(target.number) ?? 0) + (e.amountCents ?? 0));
    else unmatched.push(e);
  }
  const lines: string[] = [];
  const accts: string[] = [];
  let amount = 0;
  for (const [num, stmt] of byAcct) {
    const a = ctx.accounts.find((x) => x.number === num) as PfAccount;
    const gl = -a.balanceCents;
    if (gl !== stmt) {
      lines.push(`${label(a)} · books ${dollars(gl)} · lender ${dollars(stmt)}`);
      accts.push(label(a));
      amount += Math.abs(gl - stmt);
    }
  }
  for (const e of unmatched) {
    lines.push(`${e.label} · lender ${dollars(e.amountCents ?? 0)} · no matching loan account`);
    amount += Math.abs(e.amountCents ?? 0);
  }
  const uncovered = nonZero(loans.filter((a) => !byAcct.has(a.number)));
  for (const a of uncovered) lines.push(`${label(a)} · books ${dollars(-a.balanceCents)} · no lender statement`);
  if (lines.length === 0) {
    return pass('Loans match the lender to the cent', `${plural(byAcct.size, 'loan')} in the books ${byAcct.size === 1 ? 'matches' : 'match'} the lender ${byAcct.size === 1 ? 'statement' : 'statements'} ${ctx.at}.`, {
      accounts: labels(loans.filter((a) => byAcct.has(a.number))),
    });
  }
  return body({
    severity: 'warning',
    title: amount ? `Loans are off from the lender by ${dollars(amount)}` : `${plural(uncovered.length, 'loan')} without a lender statement`,
    message: `${shortList(lines.map((l) => l.split(' · ')[0]))}: the loan balance in the books doesn’t match the lender’s statement ${ctx.at}${uncovered.length ? ', or there’s no statement to check it against' : ''}. The usual cause is interest booked as principal, or a payment split the wrong way.`,
    fix: 'Accept a true-up entry with the lender statement attached, or drop the missing statements.',
    amountCents: amount,
    accounts: [...accts, ...labels(uncovered)],
    sample: lines,
    count: lines.length,
  });
}

// ── PF-22 — cross-client intercompany ───────────────────────────────────────────

function pf22(ctx: Ctx): Body {
  const pairs = ctx.input.intercompany;
  if (pairs.length === 0) return na('No intercompany balances', 'This client has no balances due to or from other clients in this firm.', 'Nothing to do.');
  const lines: string[] = [];
  let amount = 0;
  let mismatched = 0;
  let waiting = 0;
  for (const p of pairs) {
    const who = `${p.accountNumber} ${p.accountName}`.trim();
    if (p.otherSideCents === null) {
      waiting += 1;
      amount += Math.abs(p.thisSideCents);
      lines.push(`${who} · ${dollars(p.thisSideCents)} · waiting for ${p.counterpartyName}’s books`);
    } else if (p.thisSideCents + p.otherSideCents !== 0) {
      mismatched += 1;
      amount += Math.abs(p.thisSideCents + p.otherSideCents);
      lines.push(`${who} · ${dollars(p.thisSideCents)} here · ${dollars(-p.otherSideCents)} on ${p.counterpartyName}’s books`);
    }
  }
  if (lines.length === 0) {
    const matchMsg =
      pairs.length === 1
        ? `The intercompany balance with ${pairs[0].counterpartyName} matches their books to the cent ${ctx.at}.`
        : `All ${plural(pairs.length, 'intercompany balance')} match the other clients’ books to the cent ${ctx.at}.`;
    return pass('Intercompany balances mirror each other', matchMsg, {
      accounts: pairs.map((p) => `${p.accountNumber} ${p.accountName}`.trim()),
    });
  }
  const first = pairs.find((p) => p.otherSideCents === null || p.thisSideCents + p.otherSideCents !== 0) as (typeof pairs)[number];
  return body({
    severity: 'warning',
    title: mismatched ? `Intercompany balances don’t mirror by ${dollars(amount)}` : `Waiting for ${first.counterpartyName}’s books`,
    message: `${mismatched ? `${plural(mismatched, 'balance')} due to or from another client ${mismatched === 1 ? 'doesn’t' : 'don’t'} match what that client’s books say. What one company is owed, the other must owe; a gap means an entry recorded on one side only.` : ''}${mismatched && waiting ? ' ' : ''}${waiting ? `${plural(waiting, 'balance')} can’t be checked until the other client’s books are staged.` : ''}`,
    fix: mismatched ? 'Open the investigation pair: both clients’ entries side by side, to find the one-sided entry.' : 'Stage the other client’s books; this check re-runs when they arrive.',
    amountCents: amount,
    accounts: pairs.filter((p) => p.otherSideCents === null || p.thisSideCents + p.otherSideCents !== 0).map((p) => `${p.accountNumber} ${p.accountName}`.trim()),
    sample: lines,
    count: lines.length,
  });
}

// ── PF-23 — field-system AR vs ledger AR ────────────────────────────────────────

function pf23(ctx: Ctx): Body {
  const field = ctx.input.fieldOpenInvoices;
  const ledger = ctx.input.openInvoices;
  if (field === null) {
    return na('No field system to compare', 'Connect the field system (or drop its open-invoice export) to run this check.', 'Connect the field system, or drop its open-invoice export.');
  }
  if (ledger === null) return na('Waiting for the A/R aging report', `Drop the A/R aging report ${ctx.at} to run this check.`, `Drop the A/R aging report ${ctx.at}.`);
  const docKey = (d: string): string => d.trim().toUpperCase();
  const fieldCustomers = new Set(field.map((i) => normalizeName(i.party)));
  const index = (items: readonly PfOpenItem[]): Map<string, PfOpenItem & { total: number }> => {
    const m = new Map<string, PfOpenItem & { total: number }>();
    for (const i of items) {
      const k = docKey(i.docNumber);
      const prev = m.get(k);
      m.set(k, { ...i, total: (prev?.total ?? 0) + i.balanceCents });
    }
    return m;
  };
  const fMap = index(field);
  const lMap = index(ledger);
  const lSame = ledger.filter((i) => fieldCustomers.has(normalizeName(i.party)));
  const lines: string[] = [];
  let gross = 0;
  let fieldOnly = 0;
  let ledgerOnly = 0;
  let different = 0;
  for (const [k, f] of fMap) {
    const l = lMap.get(k);
    if (!l) {
      fieldOnly += 1;
      gross += Math.abs(f.total);
      lines.push(`${f.docNumber} · ${f.party} · ${dollars(f.total)} · only in the field system`);
    } else if (l.total !== f.total) {
      different += 1;
      gross += Math.abs(l.total - f.total);
      lines.push(`${f.docNumber} · ${f.party} · field ${dollars(f.total)} · ledger ${dollars(l.total)}`);
    }
  }
  for (const [k, l] of index(lSame)) {
    if (!fMap.has(k)) {
      ledgerOnly += 1;
      gross += Math.abs(l.total);
      lines.push(`${l.docNumber} · ${l.party} · ${dollars(l.total)} · only in the ledger`);
    }
  }
  const fTotal = sum(field.map((i) => i.balanceCents));
  const lTotal = sum(lSame.map((i) => i.balanceCents));
  if (lines.length === 0) {
    return pass('Field-system invoices match the ledger', `The field system and the ledger both show ${dollars(fTotal)} open across ${plural(fMap.size, 'invoice')} for the same customers ${ctx.at}.`, {
      count: fMap.size,
    });
  }
  const title =
    fieldOnly && !ledgerOnly && !different
      ? `${plural(fieldOnly, 'field-system invoice')} never reached the ledger`
      : ledgerOnly && !fieldOnly && !different
        ? `${plural(ledgerOnly, 'ledger invoice')} missing from the field system`
        : 'Field-system invoices don’t match the ledger';
  const parts = [
    fieldOnly ? `${plural(fieldOnly, 'invoice')} only in the field system` : '',
    ledgerOnly ? `${plural(ledgerOnly, 'invoice')} only in the ledger` : '',
    different ? `${plural(different, 'invoice')} with different balances` : '',
  ].filter(Boolean);
  return body({
    severity: 'warning',
    title,
    message: `For the same customers, the field system shows ${dollars(fTotal)} open and the ledger shows ${dollars(lTotal)} ${ctx.at}: ${list(parts)}, ${dollars(gross)} in all. Opening receivables load once, from the ledger, so anything missing there won’t be collected.`,
    fix: 'Post the missing invoices in the source before cutover, or let the matching rules decide which side is the control and carry the rest as reconciling items.',
    amountCents: gross,
    sample: lines,
    count: lines.length,
  });
}

// ── PF-24 — foreign currency ────────────────────────────────────────────────────

function pf24(ctx: Ctx): Body {
  const foreign = evidenceOf(ctx, 'currency')
    .map((e) => {
      const code = (/\b([A-Z]{3})\b/.exec(e.note ?? '') ?? /\b([A-Z]{3})\b/.exec(e.label))?.[1] ?? null;
      return { e, code };
    })
    .filter(({ code }) => code !== 'USD');
  if (foreign.length === 0) return na('USD only', 'No foreign-currency balances were found; everything is in US dollars.', 'Nothing to do.');
  const codes = [...new Set(foreign.map((f) => f.code).filter((c): c is string => c !== null))];
  const total = sum(foreign.map((f) => Math.abs(f.e.amountCents ?? 0)));
  return body({
    severity: 'info',
    title: codes.length ? `Balances in ${list(codes)}` : 'Foreign-currency balances found',
    message: `${plural(foreign.length, 'balance')}${total ? ` worth ${dollars(total)}` : ''} ${foreign.length === 1 ? 'is' : 'are'} held in a currency other than US dollars. Each client keeps one reporting currency; foreign balances come over at their US-dollar value ${ctx.at}.`,
    fix: 'Confirm the client’s reporting currency in the plan; transaction-level currency conversion is planned.',
    amountCents: total,
    sample: foreign.map(({ e, code }) => `${e.label}${code ? ` · ${code}` : ''}${e.amountCents ? ` · ${dollars(e.amountCents)}` : ''}`),
    count: foreign.length,
  });
}

// ── Runner ──────────────────────────────────────────────────────────────────────

const RUNNERS: Record<PreflightCheckId, (ctx: Ctx) => Body> = {
  'PF-01': (c) => controlTie(c, 'ar'),
  'PF-02': (c) => controlTie(c, 'ap'),
  'PF-03': pf03,
  'PF-04': pf04,
  'PF-05': pf05,
  'PF-06': pf06,
  'PF-07': pf07,
  'PF-08': pf08,
  'PF-09': pf09,
  'PF-10': pf10,
  'PF-11': pf11,
  'PF-12': pf12,
  'PF-13': pf13,
  'PF-14': pf14,
  'PF-15': pf15,
  'PF-16': pf16,
  'PF-17': pf17,
  'PF-18': pf18,
  'PF-19': pf19,
  'PF-20': pf20,
  'PF-21': pf21,
  'PF-22': pf22,
  'PF-23': pf23,
  'PF-24': pf24,
};

/** Run all 24 checks. Always 24 results, in PF order. */
export function runPreflight(input: PreflightInput): PreflightResult[] {
  const ctx = makeCtx(input);
  return PREFLIGHT_CHECKS.map((c) => ({ checkId: c.id, name: c.name, ...RUNNERS[c.id](ctx) }));
}

// ── Summary + ranking ───────────────────────────────────────────────────────────

/**
 * Roll the 24 results into the strip / gate numbers.
 *
 * `decided` holds the check ids whose disposition settles them — the CALLER decides what
 * counts: for a blocker only `fixed_in_source` or `carry_as_reconciling_item`; for a warning
 * any non-`open` disposition. `clear` = every blocker is resolved AND every warning decided
 * (info, passed and not_applicable never hold the gate). Counts include decided items.
 */
export function summarizePreflight(
  results: PreflightResult[],
  decided: ReadonlySet<PreflightCheckId>,
): {
  blockers: number;
  blockerCents: number;
  warnings: number;
  warningsUndecided: number;
  info: number;
  passed: number;
  notApplicable: number;
  clear: boolean;
} {
  const of = (s: PreflightSeverity): PreflightResult[] => results.filter((r) => r.severity === s);
  const blockers = of('blocker');
  const warnings = of('warning');
  const warningsUndecided = warnings.filter((r) => !decided.has(r.checkId)).length;
  const blockersOpen = blockers.filter((r) => !decided.has(r.checkId)).length;
  return {
    blockers: blockers.length,
    blockerCents: sum(blockers.map((r) => r.amountCents)),
    warnings: warnings.length,
    warningsUndecided,
    info: of('info').length,
    passed: of('passed').length,
    notApplicable: of('not_applicable').length,
    clear: blockersOpen === 0 && warningsUndecided === 0,
  };
}

const RANK: Record<PreflightSeverity, number> = { blocker: 0, warning: 1, info: 2, passed: 3, not_applicable: 4 };
const ORDER = new Map<PreflightCheckId, number>(PREFLIGHT_CHECKS.map((c, i) => [c.id, i]));

/** Blockers first (largest dollars first), then warnings by dollars, then info, passed, n/a; ties keep PF order. */
export function rankFindings(results: readonly PreflightResult[]): PreflightResult[] {
  return [...results].sort(
    (a, b) =>
      RANK[a.severity] - RANK[b.severity] ||
      (a.severity === 'blocker' || a.severity === 'warning' ? b.amountCents - a.amountCents : 0) ||
      (ORDER.get(a.checkId) ?? 0) - (ORDER.get(b.checkId) ?? 0),
  );
}
