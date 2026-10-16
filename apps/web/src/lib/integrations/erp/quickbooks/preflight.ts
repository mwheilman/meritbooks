/**
 * QuickBooks PRE-FLIGHT checks (FPB onboarding research T5) — a pure function over
 * the pulled data that tells the owner, in plain English and in dollars, what in
 * their QuickBooks file will make the migration messy, BEFORE they approve anything.
 *
 * Checks:
 *   1. AR aging ≠ AR control account   (blocker — opening AR detail won't tie to GL)
 *   2. AP aging ≠ AP control account   (blocker — same, for bills)
 *   3. Undeposited Funds has a balance (warning — receipts never matched to a deposit)
 *   4. Uncategorized Income / Expense / Asset has a balance (warning)
 *   5. Ask My Accountant has a balance (warning)
 *   6. Opening Balance Equity is not zero (warning)
 *
 * Balance sources:
 *   • Suspense-type checks (3–6) use the TRIAL BALANCE as of the cutover date when
 *     supplied (that is what we import); otherwise the account's current balance.
 *   • Control-tie checks (1–2) compare like with like: the open invoices/bills we
 *     pulled are as of TODAY, so they're compared to the control accounts' CURRENT
 *     balances.
 *
 * No I/O, no AI — deterministic and unit-tested.
 */

import type { QboAccountSnapshot, QboTbLine } from './transforms';

export type PreflightSeverity = 'blocker' | 'warning' | 'info';

export interface PreflightFinding {
  id:
    | 'ar_control_mismatch'
    | 'ap_control_mismatch'
    | 'undeposited_funds'
    | 'uncategorized'
    | 'ask_my_accountant'
    | 'opening_balance_equity';
  severity: PreflightSeverity;
  title: string;
  plainEnglishMessage: string;
  /** Absolute dollar impact, integer cents. */
  amountCents: number;
  /** Accounts involved (names as they appear in QuickBooks). */
  accounts: string[];
}

export interface PreflightInput {
  accounts: QboAccountSnapshot[];
  /** TB as of the cutover date (optional). */
  trialBalance?: QboTbLine[] | null;
  /** Open invoice balances (cents), as pulled today. Null = not pulled. */
  openInvoiceBalancesCents?: number[] | null;
  /** Open bill balances (cents), as pulled today. Null = not pulled. */
  openBillBalancesCents?: number[] | null;
  /** Cutover date shown in messages (YYYY-MM-DD). */
  asOfDate?: string | null;
}

const SEVERITY_ORDER: Record<PreflightSeverity, number> = { blocker: 0, warning: 1, info: 2 };

/** "$1,234.56" from integer cents — integer math only. */
export function dollars(cents: number): string {
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${cents < 0 ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

function sum(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0);
}

export function runQboPreflight(input: PreflightInput): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const active = input.accounts.filter((a) => a.active);
  const tbById = new Map<string, QboTbLine>();
  for (const l of input.trialBalance ?? []) if (l.accountId) tbById.set(l.accountId, l);
  const hasTb = !!input.trialBalance;
  const asOf = input.asOfDate ? ` on ${input.asOfDate}` : '';

  /** Absolute balance for a suspense-type account: TB-as-of when available. */
  const suspenseBalance = (a: QboAccountSnapshot): number => {
    if (hasTb) {
      const l = tbById.get(a.id);
      return l ? Math.abs(l.debitCents - l.creditCents) : 0;
    }
    return Math.abs(a.currentBalanceCents);
  };

  const suspense = (
    match: (a: QboAccountSnapshot) => boolean,
  ): { total: number; names: string[] } => {
    const hits = active.filter(match).map((a) => ({ a, bal: suspenseBalance(a) })).filter((h) => h.bal !== 0);
    return { total: sum(hits.map((h) => h.bal)), names: hits.map((h) => h.a.name) };
  };

  // 1–2. Control-account ties (like-for-like: today's open docs vs today's balances).
  const controlTie = (
    type: 'Accounts Receivable' | 'Accounts Payable',
    docs: number[] | null | undefined,
    id: 'ar_control_mismatch' | 'ap_control_mismatch',
  ) => {
    if (!docs) return;
    const ctrl = active.filter((a) => a.accountType === type);
    if (ctrl.length === 0) return;
    const ctrlTotal = sum(ctrl.map((a) => a.currentBalanceCents));
    const docsTotal = sum(docs);
    const diff = ctrlTotal - docsTotal;
    if (diff === 0) return;
    const isAr = type === 'Accounts Receivable';
    findings.push({
      id,
      severity: 'blocker',
      title: isAr ? 'Customer balances don’t add up to Accounts Receivable' : 'Bills don’t add up to Accounts Payable',
      plainEnglishMessage: isAr
        ? `Your open customer invoices total ${dollars(docsTotal)}, but the Accounts Receivable account in QuickBooks says ${dollars(ctrlTotal)} — a ${dollars(Math.abs(diff))} gap. This usually means customer payments or credits that were never applied to an invoice, or a journal entry posted straight to Accounts Receivable. Fix it in QuickBooks (apply the payments/credits), or tell us to bring the difference over as a single reconciling item.`
        : `Your open bills total ${dollars(docsTotal)}, but the Accounts Payable account in QuickBooks says ${dollars(ctrlTotal)} — a ${dollars(Math.abs(diff))} gap. This usually means bill payments or vendor credits that were never applied to a bill, or a journal entry posted straight to Accounts Payable. Fix it in QuickBooks, or tell us to bring the difference over as a single reconciling item.`,
      amountCents: Math.abs(diff),
      accounts: ctrl.map((a) => a.name),
    });
  };
  controlTie('Accounts Receivable', input.openInvoiceBalancesCents, 'ar_control_mismatch');
  controlTie('Accounts Payable', input.openBillBalancesCents, 'ap_control_mismatch');

  // 3. Undeposited Funds.
  const uf = suspense((a) => a.accountSubType === 'UndepositedFunds' || /undeposited\s+funds/i.test(a.name));
  if (uf.total !== 0) {
    findings.push({
      id: 'undeposited_funds',
      severity: 'warning',
      title: 'Payments waiting in Undeposited Funds',
      plainEnglishMessage: `QuickBooks shows ${dollars(uf.total)} in Undeposited Funds${asOf}. That’s money recorded as received but never matched to a bank deposit. If those deposits already hit your bank, they’re probably counted twice. Match them to deposits in QuickBooks before we take over, or we’ll carry the balance over for you to clear.`,
      amountCents: uf.total,
      accounts: uf.names,
    });
  }

  // 4. Uncategorized Income / Expense / Asset.
  const unc = suspense((a) => /uncategori[sz]ed\s+(income|expense|asset)/i.test(a.name));
  if (unc.total !== 0) {
    findings.push({
      id: 'uncategorized',
      severity: 'warning',
      title: 'Transactions that were never categorized',
      plainEnglishMessage: `${dollars(unc.total)} is sitting in ${unc.names.join(', ')}${asOf}. These are transactions nobody put in a real category, so your profit and your balances are off by up to that much. Categorize them in QuickBooks first, or bring them over and we’ll help sort them.`,
      amountCents: unc.total,
      accounts: unc.names,
    });
  }

  // 5. Ask My Accountant.
  const ama = suspense((a) => /ask\s+my\s+accountant/i.test(a.name));
  if (ama.total !== 0) {
    findings.push({
      id: 'ask_my_accountant',
      severity: 'warning',
      title: 'Open questions parked in “Ask My Accountant”',
      plainEnglishMessage: `${dollars(ama.total)} is parked in Ask My Accountant${asOf}. Those are transactions someone wasn’t sure how to record. Resolve them with your accountant before cutover so they don’t become MeritBooks’ opening balance.`,
      amountCents: ama.total,
      accounts: ama.names,
    });
  }

  // 6. Opening Balance Equity.
  const obe = suspense((a) => a.accountSubType === 'OpeningBalanceEquity' || /opening\s+balance\s+equity/i.test(a.name));
  if (obe.total !== 0) {
    findings.push({
      id: 'opening_balance_equity',
      severity: 'warning',
      title: 'Opening Balance Equity isn’t zero',
      plainEnglishMessage: `Opening Balance Equity shows ${dollars(obe.total)}${asOf}. QuickBooks puts amounts here when accounts were set up with starting balances; in clean books it’s zero because it’s been moved to owner’s equity or retained earnings. Ask your accountant where it belongs — we’ll bring it over as-is if you don’t change it.`,
      amountCents: obe.total,
      accounts: obe.names,
    });
  }

  return findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.amountCents - a.amountCents,
  );
}
