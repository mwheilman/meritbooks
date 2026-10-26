/**
 * Buy-in for the accounting team (spec §12, board O-buy-in): what changes, what stays,
 * time saved estimated from THEIR OWN volumes, the words that changed, and a first-week
 * checklist that runs on their real client (never a demo company). PURE — the service
 * supplies the volumes and the checklist facts from real rows.
 *
 * Time standards are stated, editable assumptions (shown on the screen next to every
 * estimate). Estimates are labelled as estimates and name the data they came from.
 */

export type BuyInRole = 'bookkeeper' | 'accounting_manager' | 'controller' | 'owner' | 'ap_clerk';
export type PriorSystem = 'quickbooks' | 'xero' | 'sage' | 'spreadsheets' | 'other';

export interface VolumeFact {
  key: 'bank_txns' | 'bills' | 'invoices' | 'bank_accounts' | 'vendors' | 'customers';
  /** Per month (accounts: count). */
  perMonth: number;
  /** Where the number came from, plain English ("Farmers State feed, last 90 days"). */
  basis: string;
}

export interface TimeStandard {
  key: VolumeFact['key'];
  label: string;
  /** Minutes per item today (manual, in the old system). */
  beforeMin: number;
  /** Minutes per item in MeritBooks (review, not typing). */
  afterMin: number;
  why: string;
}

/** Default time standards (industry rules of thumb; the firm can override). */
export const TIME_STANDARDS: readonly TimeStandard[] = [
  { key: 'bank_txns', label: 'Coding bank and card transactions', beforeMin: 1.0, afterMin: 0.2, why: 'Transactions arrive coded by your own vendor habits; Ready items batch-approve.' },
  { key: 'bills', label: 'Entering and coding bills', beforeMin: 4.0, afterMin: 1.0, why: 'Bills sent to the client’s AP address arrive read, coded and matched.' },
  { key: 'invoices', label: 'Creating and sending invoices', beforeMin: 3.0, afterMin: 1.0, why: 'Invoices from field systems flow in; reminders run on their own.' },
  { key: 'bank_accounts', label: 'Reconciling each bank account', beforeMin: 45, afterMin: 15, why: 'Matches are proposed and outstanding items carry forward automatically.' },
];

export interface TimeSavedLine {
  key: VolumeFact['key'];
  label: string;
  perMonth: number;
  basis: string;
  beforeHours: number;
  afterHours: number;
  savedHours: number;
  why: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Hours a month before / after, per activity, from real volumes. Activities with no volume are left out. */
export function estimateTimeSaved(volumes: ReadonlyArray<VolumeFact>, standards: ReadonlyArray<TimeStandard> = TIME_STANDARDS): { lines: TimeSavedLine[]; beforeHours: number; afterHours: number; savedHours: number } {
  const byKey = new Map(volumes.map((v) => [v.key, v]));
  const lines: TimeSavedLine[] = [];
  for (const s of standards) {
    const v = byKey.get(s.key);
    if (!v || v.perMonth <= 0) continue;
    const before = (v.perMonth * s.beforeMin) / 60;
    const after = (v.perMonth * s.afterMin) / 60;
    lines.push({ key: s.key, label: s.label, perMonth: v.perMonth, basis: v.basis, beforeHours: round1(before), afterHours: round1(after), savedHours: round1(before - after), why: s.why });
  }
  const beforeHours = round1(lines.reduce((t, l) => t + l.beforeHours, 0));
  const afterHours = round1(lines.reduce((t, l) => t + l.afterHours, 0));
  return { lines, beforeHours, afterHours, savedHours: round1(beforeHours - afterHours) };
}

export interface WorkflowSection {
  stays: { title: string; detail: string }[];
  automated: { title: string; detail: string }[];
  moved: { before: string; after: string }[];
  newForYou: { title: string; detail: string }[];
}

const SYSTEM_NAME: Record<PriorSystem, string> = {
  quickbooks: 'QuickBooks',
  xero: 'Xero',
  sage: 'Sage',
  spreadsheets: 'spreadsheets',
  other: 'your old system',
};

export function priorSystemFor(systemId: string | null | undefined): PriorSystem {
  if (!systemId) return 'other';
  if (systemId.startsWith('quickbooks')) return 'quickbooks';
  if (systemId === 'xero') return 'xero';
  if (systemId.startsWith('sage')) return 'sage';
  if (systemId === 'spreadsheets') return 'spreadsheets';
  return 'other';
}

/** "Where things moved" — per prior system. */
function movedFor(sys: PriorSystem): { before: string; after: string }[] {
  if (sys === 'quickbooks') {
    return [
      { before: 'Banking → For review', after: 'Bank feed — sorted by AI confidence, lowest first' },
      { before: 'Gear → Reconcile', after: 'Reconciliation, with matches proposed' },
      { before: '+ New → Journal entry', after: 'Journal entries → New (balanced before it can post)' },
      { before: 'Reports → Profit and Loss', after: 'Reports, with a period picker and drill-down' },
      { before: 'Memo “Ask My Accountant”', after: 'Ask the client from any row' },
      { before: 'Settings → Close the books', after: 'Close, with a reviewer’s sign-off' },
    ];
  }
  if (sys === 'xero') {
    return [
      { before: 'Bank accounts → Reconcile', after: 'Bank feed, then Reconciliation' },
      { before: 'Accounting → Manual journal', after: 'Journal entries → New' },
      { before: 'Accounting → Reports', after: 'Reports, with a period picker and drill-down' },
      { before: 'Advanced → Lock dates', after: 'Periods — soft close and hard close' },
    ];
  }
  if (sys === 'sage') {
    return [
      { before: 'Tasks → General Journal Entry', after: 'Journal entries → New' },
      { before: 'Tasks → Account Reconciliation', after: 'Reconciliation, with matches proposed' },
      { before: 'Reports & Forms', after: 'Reports, with a period picker and drill-down' },
      { before: 'Period close / year end wizard', after: 'Close and Year-end close, with a reviewer' },
    ];
  }
  return [
    { before: 'A spreadsheet per month', after: 'One ledger; every report from the same numbers' },
    { before: 'Emailing files for review', after: 'Send for review inside MeritBooks; the reviewer signs off' },
  ];
}

/** "What changed for my workflow" — role × prior system, filled with tenant facts. */
export function workflowFor(role: BuyInRole, sys: PriorSystem, facts: { reviewerName: string | null; billApprovalThresholdCents: number | null }): WorkflowSection {
  const from = SYSTEM_NAME[sys];
  const reviewer = facts.reviewerName ?? 'your reviewer';
  const stays = [
    { title: 'You still review every transaction', detail: 'Nothing posts from the bank feed without a person, until you choose a rule for it.' },
    { title: 'You still reconcile every account, every month', detail: 'Same statements, same sign-off. The outstanding items from the conversion are already loaded.' },
    { title: 'Your chart and your numbers', detail: `Opening balances tie to ${from} to the cent, and the certificate proves it.` },
  ];
  const automated = [
    { title: 'Bank and card transactions arrive coded', detail: 'Coded by your own vendor habits; Ready items batch-approve in one click.' },
    { title: 'Bills from email arrive drafted', detail: 'Send bills to the client’s AP address; they arrive read, coded and matched.' },
    { title: 'Data-quality checks run for you', detail: '24 checks ran before the move; the same discipline continues at every close.' },
  ];
  const newForYou: { title: string; detail: string }[] = [
    { title: 'A reviewer signs off your close', detail: `${reviewer} reviews and signs off. You send; they approve or return it with a note.` },
    { title: 'The AI explains itself', detail: 'Every suggestion carries its evidence and confidence. If AI is paused, your rules keep coding.' },
  ];
  if (facts.billApprovalThresholdCents && facts.billApprovalThresholdCents > 0) {
    newForYou.push({ title: 'Bills above a threshold need approval', detail: `Bills over $${Math.round(facts.billApprovalThresholdCents / 100).toLocaleString('en-US')} route for approval. You see where each one is.` });
  }
  if (role === 'controller' || role === 'accounting_manager') {
    newForYou.push({ title: 'Shared mapping rules', detail: 'Your answers on one client are proposed on the next. You settle a rule once when clients disagree.' });
  }
  if (role === 'owner') {
    stays.splice(0, 2, { title: 'Your team keeps doing the work', detail: 'The people who keep your books today still do — with less typing.' });
    newForYou.unshift({ title: 'A certificate for every client', detail: `Each client’s move ends with a Conversion Certificate: the old books minus the new books is zero, signed by two people.` });
  }
  if (role === 'ap_clerk') {
    automated.unshift({ title: 'Bills are read for you', detail: 'Vendor, amount, due date and coding are proposed; you check and send for approval.' });
  }
  return { stays, automated, moved: movedFor(sys), newForYou };
}

/** "Words that changed" — the terminology bridge (spec B8). */
export const TERMINOLOGY: readonly { before: string; after: string; system: PriorSystem }[] = [
  { before: 'Classes', after: 'Departments or classes', system: 'quickbooks' },
  { before: 'Sub-customers', after: 'Jobs', system: 'quickbooks' },
  { before: 'Undeposited Funds', after: 'Payment clearing', system: 'quickbooks' },
  { before: 'Memorized transactions', after: 'Recurring entries', system: 'quickbooks' },
  { before: 'Closing date', after: 'Period close (soft and hard)', system: 'quickbooks' },
  { before: 'Products and services', after: 'Items', system: 'quickbooks' },
  { before: 'Tracking categories', after: 'Departments or classes', system: 'xero' },
  { before: 'Lock dates', after: 'Period close (soft and hard)', system: 'xero' },
  { before: 'Repeating invoices', after: 'Recurring invoices', system: 'xero' },
  { before: 'Jobs (Sage)', after: 'Jobs', system: 'sage' },
  { before: 'Year-end wizard', after: 'Year-end close', system: 'sage' },
];

export interface ChecklistItem {
  key: 'first_bank_txns' | 'first_reconciliation' | 'first_bill' | 'first_invoice' | 'first_close';
  title: string;
  detail: string;
  done: boolean;
  /** Where to do it. */
  href: string;
}

export interface ChecklistFacts {
  approvedBankTxns: number;
  reconciliations: number;
  billsEntered: number;
  invoicesSent: number;
  periodsClosed: number;
}

/** The first-week path, on the real client (spec B6) — done is computed from real rows. */
export function firstWeekChecklist(f: ChecklistFacts, clientName: string): ChecklistItem[] {
  return [
    { key: 'first_bank_txns', title: 'Approve your first 10 bank transactions', detail: `${clientName} · ${Math.min(f.approvedBankTxns, 10)} of 10`, done: f.approvedBankTxns >= 10, href: '/bank-feed' },
    { key: 'first_reconciliation', title: 'Reconcile a bank account', detail: `${clientName} · outstanding items from the conversion are pre-loaded`, done: f.reconciliations >= 1, href: '/reconciliation' },
    { key: 'first_bill', title: 'Enter or approve your first bill', detail: `${clientName} · from the AP inbox or by hand`, done: f.billsEntered >= 1, href: '/bills' },
    { key: 'first_invoice', title: 'Send your first invoice', detail: `${clientName}`, done: f.invoicesSent >= 1, href: '/invoices' },
    { key: 'first_close', title: 'Run your first close checklist', detail: `${clientName} · soft-close the first month`, done: f.periodsClosed >= 1, href: '/close' },
  ];
}
