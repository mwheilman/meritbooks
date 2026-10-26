/**
 * Onboarding v2 — DETERMINISTIC recognition of one dropped spreadsheet (spec §4.3 recipe tier:
 * "a parser profile that recognizes the file deterministically"; P5 works with AI off).
 *
 * Input: ONE grid (one sheet / CSV, cells as display text). Output: what the file is, its records
 * normalized to the staged shape (integer cents, ISO dates), the control totals that let it be
 * certified, and every row we skipped with a plain reason (never silent).
 *
 * Accounting exports put TITLE ROWS above the real header (company, report name, "As of September 30,
 * 2026"), group rows under SECTION HEADINGS ("Current", "1 - 30 days past due", a contact name in
 * Xero), and add SUBTOTAL rows ("Total for Current", "TOTAL"). We find the real header by scoring
 * every one of the first 40 rows against each entity's header signature, then walk the rows.
 *
 * Rules only — no AI, no I/O, no clock. Money via parseAccountingAmount (string → cents, no float
 * math). A General Ledger DETAIL export is not a trial balance: it returns entity null with the
 * plain export steps (history import is part 2).
 */

import { normHeader, parseAccountingAmount, type Grid } from '@/lib/import/spreadsheet';
import {
  GL_DETAIL_NOT_TB_MESSAGE,
  looksLikeGeneralLedgerDetail,
  normalizeTrialBalanceGrid,
  parseLooseDate,
  splitAccountLabel,
} from '@/lib/onboarding/tb-import/spreadsheet-tb';
import { dollars, longDate, plural } from './format';
import type {
  MeritAccountType,
  StagedAccount,
  StagedBankBalance,
  StagedDimension,
  StagedEntity,
  StagedItem,
  StagedJob,
  StagedOpenItem,
  StagedParty,
  StagedPayload,
  StagedTbLine,
} from './types';

export interface RecognizedFile {
  /** null = not recognized. */
  entity: StagedEntity | null;
  /** 0..1 */
  confidence: number;
  /** e.g. 'generic.tb v1', 'quickbooks.ar_aging v1', 'innergy.wip v1'. */
  parser: string;
  /** Plain English: "Trial balance as of Sep 30, 2026 · 251 accounts". */
  label: string;
  records: StagedPayload[];
  /** e.g. { debitCents, creditCents } / { openBalanceCents, count }. */
  controlTotals: Record<string, number>;
  /** ISO date found in the title rows. */
  asOfHint: string | null;
  /** Title / heading / subtotal / footer rows skipped, with plain reasons. Blank rows are skipped silently. */
  dropped: { row: number; reason: string }[];
  warnings: string[];
}

export interface RecognizeOptions {
  fileName?: string;
  /** Catalog id of the system the file came from (names the parser profile). */
  systemId?: string | null;
  /** The recipe slot the user dropped the file into (breaks ties; mismatch → warning). */
  expectEntity?: StagedEntity | null;
}

type Dropped = { row: number; reason: string };

const SCAN_ROWS = 40;

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────────

function rowCells(grid: Grid, r: number): string[] {
  return (grid[r] ?? []).map((c) => (c == null ? '' : String(c).trim()));
}

const isBlank = (cells: string[]): boolean => cells.every((c) => c === '');
const firstText = (cells: string[]): string => cells.find((c) => c !== '') ?? '';
const truncate = (s: string, n = 60): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** First column whose normalized header matches the earliest test (tests are in priority order). */
function col(h: string[], tests: readonly RegExp[], taken: readonly number[] = []): number {
  for (const t of tests) {
    const i = h.findIndex((c, idx) => c !== '' && !taken.includes(idx) && t.test(c));
    if (i >= 0) return i;
  }
  return -1;
}

const get = (cells: string[], i: number): string => (i >= 0 ? (cells[i] ?? '').trim() : '');

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function validYmd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** parseLooseDate + the forms it doesn't cover: "30 September 2026" (Xero), "9/30/26". */
function parseDate(text: string): string | null {
  const s = (text ?? '').trim();
  if (!s) return null;
  const loose = parseLooseDate(s);
  if (loose) return loose;
  let m = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return validYmd(Number(m[3]), mo, Number(m[1]));
  }
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/);
  if (m) return validYmd(2000 + Number(m[3]), Number(m[1]), Number(m[2]));
  return null;
}

/** Cents or null (blank → 0 via parseAccountingAmount; unreadable → null). */
function cents(raw: string): number | null {
  const p = parseAccountingAmount(raw);
  return p.ok ? p.cents : null;
}

function intOrNull(raw: string): number | null {
  const s = raw.replace(/[,\s]/g, '');
  return /^\d+$/.test(s) ? Number(s) : null;
}

const YES_RE = /^(yes|y|true|t|1|x|✓|checked|1099|eligible)$/i;
const NO_RE = /^(no|n|false|f|0|not eligible)?$/i;

function yesNo(raw: string): boolean | null {
  const s = raw.trim();
  if (YES_RE.test(s)) return true;
  if (NO_RE.test(s)) return false;
  return null;
}

/** Active flag from a status / active / inactive column. */
function activeFrom(header: string, raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if (header === 'inactive') {
    const yn = yesNo(v);
    return yn == null ? undefined : !yn;
  }
  if (/^(inactive|archived|deleted|closed|disabled|no|false|0)$/.test(v)) return false;
  if (/^(active|open|yes|true|1)$/.test(v)) return true;
  return undefined;
}

const TOTAL_RE = /^(grand\s+)?totals?\b/i;
const GRAND_TOTAL_RE = /^(grand\s+)?totals?:?$/i;

/**
 * A subtotal / total row. "TOTAL", "Total for Current" always; "Total Menards" (Xero per-contact
 * subtotal) only when the row's identity cells (doc #, date, job # …) are empty — so a real vendor
 * called "Total Comfort HVAC" with a phone number is never dropped.
 */
const isSubtotal = (lbl: string, identityEmpty: boolean): boolean =>
  GRAND_TOTAL_RE.test(lbl) || /^total for\b/i.test(lbl) || (identityEmpty && TOTAL_RE.test(lbl));
const FOOTER_RE = /^(accrual|cash|modified cash) basis\b|\bGMT[+-]\d|^page \d+/i;
const BUCKET_RE = /^(current|not yet due|\d+\s*[-–]\s*\d+\s*(days)?(\s*past due)?|(over|>)\s*\d+\s*(days)?(\s*past due)?|\d+\s*(\+|or more|and over)\s*(days)?(\s*past due)?|older|<\s*1\s*month|\d+\s*months?|future)$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Header signatures (tests run on normHeader output: lower-case, punctuation → space, '#' kept)
// ─────────────────────────────────────────────────────────────────────────────

const H = {
  debit: [/\bdebits?\b/, /^dr$/],
  credit: [/\bcredits?\b/, /^cr$/],
  tbBalance: [/^(balance|ending balance|net|amount|total|net balance|balance total)$/],
  tbAccount: [/\b(account|accounts|acct|number|no|code|gl)\b/, /#/, /\b(name|description|title)\b/],

  // aging
  partyAR: [/^customer( full)?( name)?$/, /^client( name)?$/, /^bill to$/],
  partyAP: [/^vendor( full)?( name)?$/, /^supplier( name)?$/, /^payee( name)?$/],
  partyAny: [/^(name|contact|contact name|contactname|full name|display name|customer vendor)$/],
  doc: [
    /^(num|no|number|#)$/,
    /^(invoice|bill|inv|doc|document|transaction|txn|ref|reference) ?(#|no|num|number)$/,
    /^(invoice|bill) (reference|ref)$/,
    /^(reference|ref)$/,
    /^(invoice|bill|document)$/,
  ],
  date: [/^(date|invoice date|bill date|transaction date|txn date|doc date|document date|issue date|invoice dt)$/],
  due: [/^(due date|date due|due on|due dt)$/],
  openBalExplicit: [/^open balance$/, /^(balance due|amount due|open amount|amount open|remaining balance|unpaid balance|outstanding|amount outstanding|outstanding balance|balance outstanding|total due|total outstanding)$/],
  balanceLoose: [/^balance$/, /^total$/],
  amount: [/^(amount|total amount|original amount|invoice amount|bill amount|invoice total|bill total|orig amount|original)$/],
  txnType: [/^(transaction type|type|txn type)$/],

  // parties
  partyName: [
    /^display name$/,
    /^(customer|vendor|supplier|client|payee) (full )?name$/,
    /^(customer|vendor|supplier|client|payee)$/,
    /^(contactname|contact name|name|full name|company|company name|business name)$/,
  ],
  email: [/^(e ?mail|email address|emailaddress|main email|primary email|e mail address)$/, /\bemail\b/],
  phone: [/^(phone|main phone|phone number|phonenumber|telephone|tel|mobile|work phone|business phone|phone numbers)$/, /\bphone\b/],
  address: [/^(billing address|bill address|address|street address|street|billing street|address 1|address line 1|poaddressline1|billing address line 1|service address|remit to)$/],
  city: [/^(city|billing city|pocity|town)$/],
  state: [/^(state|billing state|province|poregion|region|state province)$/],
  zip: [/^(zip|zip code|postal code|billing zip|popostalcode|postcode|billing zip code)$/],
  taxId: [/^(tax id|taxid|tin|ein|ssn|tax number|taxnumber|federal id|federal tax id|tax id number|tax identification number|business id no|business number|vendor tax id|tax reg no)$/],
  ytd: [/^(1099 amount|total paid|ytd paid|paid ytd|ytd payments|payments ytd|amount paid|total payments|nec box 1|box 1 nec|nonemployee compensation|ytd total)$/],
  flag1099: [/^(1099 tracking|track payments for 1099|eligible for 1099|vendor eligible for 1099|1099 vendor|is 1099|1099|1099 eligible|tax 1099|form 1099 type|1099 type)$/],
  partyBalance: [/^(open balance|balance|balance due|amount due|outstanding)$/],
  active: [/^(status|active|is active|inactive|active status)$/],
  partyOther: [/^(terms|payment terms|account #|account no|company name|website|fax|contact|full name|customer type|vendor type)$/],

  // items
  itemName: [/^(product service name|product service|item name|item|product name|product|service name|service|part name|item description)$/],
  sku: [/^(sku|item code|part #|part number|part no|code|item #|item number|product code|item id)$/],
  itemKind: [/^(type|item type|product type|category|item category)$/],
  income: [/^(income account|sales account|revenue account|income acct|account)$/],
  price: [/\b(sales price|price|rate|unit price|sales rate|purchase cost|cost)\b/],
  description: [/\bdescription\b/],

  // chart of accounts
  acctNumber: [/^(account #|account number|acct #|acct no|account no|accnt #|accnt|number|no|#|code|account code|gl code|gl account #|account id)$/],
  acctName: [/^(account name|account full name|full name|name|account|title|account title)$/],
  acctType: [/^(type|account type|acct type|account category|account class)$/],
  acctDetail: [/^(detail type|detail|sub type|subtype|account subtype|account sub type|detail account type|account detail type)$/],
  acctBalance: [/^(balance|total balance|balance total|ending balance|current balance|ytd balance|qbo balance)$/],

  // dimensions
  dim: [/^(class|classes|class name|class full name|location|locations|location name|department|departments|department name|division|divisions|division name|business unit|business units|business unit name|store|stores|store name|branch|branches|cost centre|cost center|cost centres|cost centers|business group|tracking category)$/],

  // jobs
  jobNumber: [/^(job #|job number|job no|job num|job id|project #|project number|project no|project id|wo #|work order #|work order number|work order no|contract #|job code|order #|order number)$/],
  jobNameSpecific: [/^(job name|project name|job description|project|job|job title|project title|work order)$/],
  jobNameLoose: [/^(name|description)$/],
  jobCustomer: [/^(customer|customer name|client|client name|owner|owner name|bill to)$/],
  jobStatus: [/^(status|job status|project status|stage|order status)$/],
  contractRevised: [/^(revised contract|current contract|contract value|revised contract amount|contract amount|total contract|contract total|adjusted contract|contract price|revised contract value|selling price|order total)$/],
  contractOriginal: [/^(original contract|contract|original contract amount|base contract|original contract value)$/],
  changeOrders: [/^(change orders|approved change orders|change order|change order amount|cos|co amount|approved cos|change orders amount|variations)$/],
  cost: [/^(cost to date|costs to date|actual cost|actual costs|job cost|job costs|total cost|total costs|costs|cost|actual cost to date|jtd cost|job to date cost|costs incurred)$/],
  billed: [/^(billed to date|billed|total billed|invoiced to date|invoiced|amount billed|billings to date|billings|jtd billed|amount invoiced)$/],
  earned: [/^(earned revenue|earned to date|earned|revenue earned|earned revenue to date)$/],
  overUnder: [/\bover\b.*\bunder\b|\bunder\b.*\bover\b/],
  under: [/^(underbillings|under billings|underbilled|under billed|costs in excess( of billings)?|unbilled|unbilled revenue|costs and estimated earnings in excess of billings)$/],
  over: [/^(overbillings|over billings|overbilled|over billed|billings in excess( of costs)?|billings in excess of costs and estimated earnings)$/],
  retainage: [/^(retainage|retention|retainage receivable|retainage held|retainage billed)$/],

  // bank
  bankLabel: [/^(bank account|account|account name|bank|bank name|cash account|bank account name)$/],
  bankGl: [/^(gl account|gl account #|gl #|gl|ledger account|gl account number|gl code)$/],
  stmtBal: [/^(statement ending balance|statement balance|ending balance|balance per bank|bank balance|statement ending|ending statement balance|closing balance|statement closing balance)$/],
  stmtDate: [/^(statement date|statement ending date|statement end date|period ending|period end|ending date|as of|statement period end)$/],
  reconciled: [/^(reconciled through|last reconciled|last reconciled date|reconciled to|reconciled as of|last reconciliation|reconciled date|reconciled on)$/],
  unclCount: [/^(uncleared items|uncleared count|outstanding items|# uncleared|uncleared #|uncleared transactions|number uncleared|outstanding count)$/],
  unclTotal: [/^(uncleared total|uncleared amount|outstanding total|total uncleared|outstanding amount|uncleared balance)$/],
  oldestUncl: [/^(oldest uncleared|oldest uncleared date|oldest outstanding|oldest outstanding date)$/],
} as const;

const ITEM_HEADER_RE = /\b(item|product|service|sku|part)\b/;

// ─────────────────────────────────────────────────────────────────────────────
// Detectors: score one candidate header row
// ─────────────────────────────────────────────────────────────────────────────

type DetectorKind = 'tb' | 'aging' | 'party' | 'item' | 'account' | 'dimension' | 'job' | 'bank';

const DETECTOR_ENTITIES: Record<DetectorKind, StagedEntity[]> = {
  tb: ['tb_line'],
  aging: ['open_invoice', 'open_bill'],
  party: ['customer', 'vendor'],
  item: ['item'],
  account: ['account'],
  dimension: ['dimension'],
  job: ['job'],
  bank: ['bank_balance'],
};

/** Tie-break order when two detectors score the same. */
const DETECTOR_ORDER: DetectorKind[] = ['aging', 'tb', 'job', 'bank', 'account', 'item', 'party', 'dimension'];

const has = (h: string[], tests: readonly RegExp[]): boolean => col(h, tests) >= 0;
const hasAnyBucket = (h: string[]): boolean => h.some((c) => c !== '' && BUCKET_RE.test(c));

function scoreTb(h: string[]): number {
  if (has(h, H.debit) && has(h, H.credit)) return 0.9;
  if (has(h, H.tbBalance) && has(h, H.tbAccount) && !has(h, H.acctType)) return 0.55;
  return 0;
}

function scoreAging(h: string[], title: string): number {
  const docIdx = col(h, H.doc);
  const balIdx = col(h, [...H.openBalExplicit, ...H.balanceLoose], [docIdx]);
  if (docIdx < 0 || balIdx < 0) return 0;
  const due = has(h, H.due);
  const explicit = has(h, H.openBalExplicit);
  const buckets = hasAnyBucket(h);
  const agingTitle = /\b(aging|aged|ageing|open invoices|unpaid bills|open bills|receivables|payables)\b/i.test(title);
  if (!(due || explicit || buckets || agingTitle)) return 0;
  if (!(has(h, H.date) || due)) return 0;
  const party = has(h, H.partyAR) || has(h, H.partyAP) || has(h, H.partyAny);
  let s = 0.6;
  if (party) s += 0.15;
  if (due) s += 0.1;
  if (explicit) s += 0.05;
  if (agingTitle) s += 0.1;
  return Math.min(s, 0.95);
}

function scoreParty(h: string[]): number {
  if (!has(h, H.partyName)) return 0;
  if (has(h, H.debit) && has(h, H.credit)) return 0;
  if (has(h, H.doc) && (has(h, H.date) || has(h, H.due))) return 0;
  const kinds = [H.email, H.phone, H.address, H.taxId, H.ytd, H.flag1099, H.partyBalance, H.partyOther].filter((t) => has(h, t)).length;
  if (kinds === 0) return 0;
  return Math.min(0.65 + 0.05 * kinds, 0.85);
}

function scoreItem(h: string[]): number {
  const name = has(h, H.itemName);
  const sku = has(h, H.sku);
  if (!name && !sku) return 0;
  const extras = [H.itemKind, H.sku, H.income, H.price, H.description].filter((t) => has(h, t)).length;
  if (extras === 0) return 0;
  return name ? 0.8 : 0.65;
}

function scoreAccount(h: string[]): number {
  if (has(h, H.debit) && has(h, H.credit)) return 0;
  if (h.some((c) => ITEM_HEADER_RE.test(c))) return 0;
  const num = has(h, H.acctNumber);
  const name = has(h, H.acctName);
  if (!num && !name) return 0;
  const accountWord = h.some((c) => /\b(account|acct|accnt)\b/.test(c));
  if (has(h, H.acctType)) return has(h, H.acctDetail) ? 0.9 : 0.85;
  if (num && name && accountWord && h.filter((c) => c !== '').length <= 4) return 0.6;
  return 0;
}

function scoreDimension(h: string[], title: string): number {
  const nonEmpty = h.filter((c) => c !== '').length;
  if (has(h, H.dim)) return nonEmpty <= 4 ? 0.75 : 0.5;
  if (/\b(class|location|department|division|business unit|store) list\b/i.test(title) && has(h, [/^(name|full name)$/]) && nonEmpty <= 4) return 0.7;
  return 0;
}

function scoreJob(h: string[]): number {
  const idCol = has(h, H.jobNumber) || has(h, H.jobNameSpecific);
  if (!idCol) return 0;
  const money = [H.contractRevised, H.contractOriginal, H.changeOrders, H.cost, H.billed, H.earned, H.overUnder, H.under, H.over, H.retainage].filter((t) => has(h, t)).length;
  if (money >= 2) return 0.85;
  if (money === 1 && has(h, H.jobNumber)) return 0.6;
  return 0;
}

function scoreBank(h: string[]): number {
  if (!has(h, H.bankLabel) || !has(h, H.stmtBal)) return 0;
  return has(h, H.stmtDate) || has(h, H.reconciled) ? 0.9 : 0.8;
}

function scoreRow(kind: DetectorKind, h: string[], title: string): number {
  switch (kind) {
    case 'tb': return scoreTb(h);
    case 'aging': return scoreAging(h, title);
    case 'party': return scoreParty(h);
    case 'item': return scoreItem(h);
    case 'account': return scoreAccount(h);
    case 'dimension': return scoreDimension(h, title);
    case 'job': return scoreJob(h);
    case 'bank': return scoreBank(h);
  }
}

/** Rows that look like data (a number in a cell) can't be headers. */
function looksLikeDataRow(cells: string[]): boolean {
  return cells.some((c) => /^\(?-?\$?\s*\d[\d,]*\.\d{2}\)?-?$/.test(c));
}

// ─────────────────────────────────────────────────────────────────────────────
// Context shared by the parsers
// ─────────────────────────────────────────────────────────────────────────────

interface Ctx {
  grid: Grid;
  headerIdx: number;
  /** Normalized header cells. */
  h: string[];
  titleText: string;
  fileName: string;
  prefix: string;
  expect: StagedEntity | null;
  asOf: string | null;
  dropped: Dropped[];
  warnings: string[];
}

type ParseOut = {
  entity: StagedEntity;
  kind: string;
  confidence: number;
  label: string;
  records: StagedPayload[];
  controlTotals: Record<string, number>;
};

function titleRowsBefore(grid: Grid, headerIdx: number): { text: string; dropped: Dropped[]; lines: string[] } {
  const dropped: Dropped[] = [];
  const lines: string[] = [];
  for (let r = 0; r < headerIdx; r++) {
    const cells = rowCells(grid, r);
    if (isBlank(cells)) continue;
    const text = cells.filter((c) => c !== '').join(' ');
    lines.push(text);
    dropped.push({ row: r + 1, reason: `“${truncate(text)}” is a report title row — read for the company and date, not imported.` });
  }
  return { text: lines.join(' \n '), dropped, lines };
}

/** "As of September 30, 2026" / "As at 30 September 2026" / "Period ending 09/30/2026" / a lone date line. */
function findAsOf(lines: string[]): string | null {
  for (const line of lines) {
    const m = line.match(/\b(?:as of|as at|through|thru|period ending|period ended|ending|ended|statement date)\b[:\s]*(.+)$/i);
    if (m) {
      const d = parseDate(m[1]);
      if (d) return d;
    }
  }
  for (const line of lines) {
    if (line.length <= 40) {
      const d = parseDate(line);
      if (d) return d;
    }
  }
  return null;
}

function headerDropped(headerIdx: number): Dropped {
  return { row: headerIdx + 1, reason: 'Column headings — used to read the file, not imported.' };
}

function prefixFor(systemId: string | null | undefined, grid: Grid): string {
  if (systemId && /^[a-z0-9][a-z0-9-]*$/.test(systemId)) return systemId;
  const qbFooter = grid.some((row) => (row ?? []).some((c) => typeof c === 'string' && /^(accrual|cash) basis\b/i.test(c.trim())));
  return qbFooter ? 'quickbooks' : 'generic';
}

const ENTITY_NOUN: Record<StagedEntity, { a: string; filed: string }> = {
  tb_line: { a: 'a trial balance', filed: 'a trial balance' },
  account: { a: 'a chart of accounts', filed: 'a chart of accounts' },
  open_invoice: { a: 'an A/R aging', filed: 'A/R' },
  open_bill: { a: 'an A/P aging', filed: 'A/P' },
  customer: { a: 'a customer list', filed: 'customers' },
  vendor: { a: 'a vendor list', filed: 'vendors' },
  item: { a: 'an item list', filed: 'items' },
  dimension: { a: 'a class / location list', filed: 'classes and locations' },
  job: { a: 'a job / WIP list', filed: 'jobs' },
  bank_balance: { a: 'a bank reconciliation summary', filed: 'bank balances' },
  evidence: { a: 'a supporting document', filed: 'a supporting document' },
};

function mismatchWarning(found: StagedEntity, expected: StagedEntity): string {
  return `This looks like ${ENTITY_NOUN[found].a}, not ${ENTITY_NOUN[expected].a} — we filed it as ${ENTITY_NOUN[found].filed}.`;
}

const round2 = (n: number): number => Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;

/** Deterministic tie-break between two sides (AR/AP, customer/vendor). */
function pickSide<T extends StagedEntity>(
  a: T,
  b: T,
  signals: { header: T | null; title: T | null; file: T | null },
  expect: StagedEntity | null,
): { entity: T; decided: boolean } {
  if (signals.header) return { entity: signals.header, decided: true };
  if (signals.title) return { entity: signals.title, decided: true };
  if (signals.file) return { entity: signals.file, decided: true };
  if (expect === a || expect === b) return { entity: expect as T, decided: true };
  return { entity: a, decided: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsers
// ─────────────────────────────────────────────────────────────────────────────

/** Record a total / footer row as dropped. `identityEmpty`: the row has no doc #, date, number … */
function dropTotalOrFooter(ctx: Ctx, rowNum: number, lbl: string, identityEmpty: boolean): boolean {
  if (isSubtotal(lbl, identityEmpty)) {
    ctx.dropped.push({ row: rowNum, reason: `“${truncate(lbl)}” is a total row, not a record — skipped.` });
    return true;
  }
  if (FOOTER_RE.test(lbl)) {
    ctx.dropped.push({ row: rowNum, reason: `“${truncate(lbl)}” is the report footer — skipped.` });
    return true;
  }
  return false;
}

function parseTb(ctx: Ctx): ParseOut | { error: string } {
  const res = normalizeTrialBalanceGrid(ctx.grid);
  if (!res.ok) return { error: res.error };
  const headerIdx = res.headerRow - 1;
  const rawHeader = rowCells(ctx.grid, headerIdx).map(normHeader);
  const debitIdx = col(rawHeader, H.debit);
  const creditIdx = col(rawHeader, H.credit);
  const typeIdx = col(rawHeader, H.acctType);
  const detailIdx = col(rawHeader, H.acctDetail);

  const title = titleRowsBefore(ctx.grid, headerIdx);
  ctx.dropped.push(...title.dropped, headerDropped(headerIdx));
  if (!ctx.asOf) ctx.asOf = res.asOfDateHint ?? findAsOf(title.lines);

  // Report TOTAL row (dropped by the TB normalizer) → self-check.
  let reportDebit: number | null = null;
  let reportCredit: number | null = null;
  for (const d of res.dropped) {
    const cells = rowCells(ctx.grid, d.row - 1);
    const lbl = firstText(cells);
    if (FOOTER_RE.test(lbl)) {
      ctx.dropped.push({ row: d.row, reason: `“${truncate(lbl)}” is the report footer — skipped.` });
      continue;
    }
    ctx.dropped.push(d);
    if (GRAND_TOTAL_RE.test(lbl) && debitIdx >= 0 && creditIdx >= 0) {
      reportDebit = cents(get(cells, debitIdx));
      reportCredit = cents(get(cells, creditIdx));
    }
  }

  const records: StagedPayload[] = [];
  let debitCents = 0;
  let creditCents = 0;
  for (const line of res.lines) {
    const cells = rowCells(ctx.grid, line.row - 1);
    const sourceType = get(cells, typeIdx) || null;
    const detailType = get(cells, detailIdx) || null;
    const data: StagedTbLine = {
      number: line.accountNumber ?? line.accountName,
      name: line.accountName,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      type: inferAccountType({ number: line.accountNumber, name: line.accountName, sourceType, detailType }),
      sourceType,
      detailType,
    };
    debitCents += line.debitCents;
    creditCents += line.creditCents;
    records.push({ entity: 'tb_line', data });
  }

  const diff = debitCents - creditCents;
  if (diff !== 0) {
    ctx.warnings.push(`Debits and credits differ by ${dollars(Math.abs(diff))}. A trial balance always balances — check the export settings (Accrual, the full year to your cutover date).`);
  }
  if (reportDebit != null && reportCredit != null && (reportDebit !== debitCents || reportCredit !== creditCents)) {
    ctx.warnings.push(
      `The file’s TOTAL row (${dollars(reportDebit)} / ${dollars(reportCredit)}) doesn’t match the accounts we read (${dollars(debitCents)} / ${dollars(creditCents)}). Some rows may have been skipped — see the skipped rows.`,
    );
  }
  const noNumbers = res.lines.every((l) => l.accountNumber == null);
  if (noNumbers) ctx.warnings.push('No account numbers in this file — accounts are matched by name. Turning on account numbers before exporting makes matching more reliable.');

  const controlTotals: Record<string, number> = { debitCents, creditCents, differenceCents: diff, count: records.length };
  if (reportDebit != null) controlTotals.reportDebitCents = reportDebit;
  if (reportCredit != null) controlTotals.reportCreditCents = reportCredit;

  return {
    entity: 'tb_line',
    kind: 'tb',
    confidence: useDebitCreditConfidence(res.columns.debit, diff),
    label: `Trial balance${ctx.asOf ? ` as of ${longDate(ctx.asOf)}` : ''} · ${plural(records.length, 'account')}`,
    records,
    controlTotals,
  };
}

function useDebitCreditConfidence(debitHeader: string | null, diff: number): number {
  const base = debitHeader ? 0.95 : 0.7;
  return diff === 0 ? base : base - 0.15;
}

function parseAging(ctx: Ctx, baseScore: number): ParseOut {
  const { h } = ctx;
  const docIdx = col(h, H.doc);
  const balIdx = col(h, [...H.openBalExplicit, ...H.balanceLoose], [docIdx]);
  const amtIdx = col(h, H.amount, [docIdx, balIdx]);
  const dateIdx = col(h, H.date, [docIdx]);
  const dueIdx = col(h, H.due, [docIdx, dateIdx]);
  const arIdx = col(h, H.partyAR);
  const apIdx = col(h, H.partyAP);
  const anyIdx = col(h, H.partyAny);
  const partyIdx = arIdx >= 0 ? arIdx : apIdx >= 0 ? apIdx : anyIdx;
  const typeIdx = col(h, H.txnType, [docIdx, partyIdx]);

  const t = ctx.titleText.toLowerCase();
  const fileN = ctx.fileName.toLowerCase();
  const side = pickSide<'open_invoice' | 'open_bill'>(
    'open_invoice',
    'open_bill',
    {
      header: arIdx >= 0 ? 'open_invoice' : apIdx >= 0 ? 'open_bill' : null,
      title: /\b(receivables?|a\/r|ar aging|aged receivables|open invoices)\b/.test(t) ? 'open_invoice' : /\b(payables?|a\/p|ap aging|aged payables|unpaid bills|open bills)\b/.test(t) ? 'open_bill' : null,
      file: /(receivable|\bar[\s_-]|a-r|invoices)/.test(fileN) ? 'open_invoice' : /(payable|\bap[\s_-]|a-p|bills)/.test(fileN) ? 'open_bill' : null,
    },
    ctx.expect,
  );
  const entity = side.entity;
  const isAR = entity === 'open_invoice';
  if (!side.decided) ctx.warnings.push('We couldn’t tell whether this is receivables or payables — we filed it as A/R. Move it if that’s wrong.');

  const records: StagedPayload[] = [];
  let openBalanceCents = 0;
  let unappliedCents = 0;
  let unappliedCount = 0;
  let reportTotal: number | null = null;
  let heading: string | null = null;

  for (let r = ctx.headerIdx + 1; r < ctx.grid.length; r++) {
    const cells = rowCells(ctx.grid, r);
    if (isBlank(cells)) continue;
    const rowNum = r + 1;
    const lbl = firstText(cells);
    const balRaw = get(cells, balIdx);

    const doc = get(cells, docIdx);
    const party = get(cells, partyIdx);
    const dateRaw = get(cells, dateIdx);
    if (GRAND_TOTAL_RE.test(lbl)) reportTotal = cents(balRaw);
    if (dropTotalOrFooter(ctx, rowNum, lbl, doc === '' && parseDate(dateRaw) == null)) continue;
    // A heading row: nothing open, no doc #, and no real date (Xero puts the contact name in the date column).
    if (balRaw === '' && doc === '' && (dateRaw === '' || parseDate(dateRaw) == null)) {
      if (BUCKET_RE.test(lbl)) {
        ctx.dropped.push({ row: rowNum, reason: `“${truncate(lbl)}” is an aging bucket heading — skipped.` });
      } else {
        heading = lbl;
        ctx.dropped.push({
          row: rowNum,
          reason: partyIdx < 0
            ? `“${truncate(lbl)}” is a section heading — used as the ${isAR ? 'customer' : 'vendor'} for the rows under it.`
            : `“${truncate(lbl)}” is a section heading — skipped.`,
        });
      }
      continue;
    }
    const bal = cents(balRaw);
    if (bal == null) {
      ctx.dropped.push({ row: rowNum, reason: `Couldn’t read the open balance “${truncate(balRaw, 20)}” — skipped. Check the number format.` });
      continue;
    }
    const partyName = party || (partyIdx < 0 && heading && !BUCKET_RE.test(heading) ? heading : '');
    if (!partyName) {
      ctx.dropped.push({ row: rowNum, reason: `No ${isAR ? 'customer' : 'vendor'} on this row — skipped.` });
      continue;
    }
    if (bal === 0) {
      ctx.dropped.push({ row: rowNum, reason: `${doc ? `“${truncate(doc, 20)}”` : 'This row'} has nothing open — skipped.` });
      continue;
    }
    const date = parseDate(dateRaw);
    const total = amtIdx >= 0 ? cents(get(cells, amtIdx)) : null;
    const txnType = get(cells, typeIdx);
    const docNumber = doc || `${txnType || (isAR ? 'Item' : 'Bill')} ${date ?? `row ${rowNum}`}`;
    const item: StagedOpenItem = {
      docNumber,
      party: partyName,
      date,
      dueDate: parseDate(get(cells, dueIdx)),
      totalCents: total ?? bal,
      balanceCents: bal,
    };
    if (bal < 0) {
      item.unapplied = true;
      unappliedCents += bal;
      unappliedCount += 1;
    }
    openBalanceCents += bal;
    records.push({ entity, data: item });
  }

  const what = isAR ? 'A/R aging' : 'A/P aging';
  const noun = isAR ? 'open invoice' : 'open bill';
  if (reportTotal != null && reportTotal !== openBalanceCents) {
    ctx.warnings.push(`The file’s TOTAL (${dollars(reportTotal)}) doesn’t match the items we read (${dollars(openBalanceCents)}). Some rows may have been skipped — see the skipped rows.`);
  }
  if (unappliedCount > 0) {
    ctx.warnings.push(`${plural(unappliedCount, isAR ? 'unapplied payment or credit' : 'unapplied credit or payment', isAR ? 'unapplied payments or credits' : 'unapplied credits or payments')} (${dollars(unappliedCents)}) — carried as negative open items.`);
  }
  if (dueIdx < 0) ctx.warnings.push('No due dates in this file — aging buckets will use the document date.');

  const controlTotals: Record<string, number> = { openBalanceCents, count: records.length, unappliedCents, unappliedCount };
  if (reportTotal != null) controlTotals.reportTotalCents = reportTotal;

  return {
    entity,
    kind: isAR ? 'ar_aging' : 'ap_aging',
    confidence: side.decided ? baseScore : baseScore - 0.2,
    label: `${what}${ctx.asOf ? ` as of ${longDate(ctx.asOf)}` : ''} · ${plural(records.length, noun)} · ${dollars(openBalanceCents)}`,
    records,
    controlTotals,
  };
}

function parseParty(ctx: Ctx, baseScore: number): ParseOut {
  const { h } = ctx;
  const nameIdx = col(h, H.partyName);
  const emailIdx = col(h, H.email, [nameIdx]);
  const phoneIdx = col(h, H.phone, [nameIdx]);
  const addrIdx = col(h, H.address, [nameIdx]);
  const cityIdx = col(h, H.city);
  const stateIdx = col(h, H.state);
  const zipIdx = col(h, H.zip);
  const taxIdx = col(h, H.taxId);
  const ytdIdx = col(h, H.ytd);
  const flagIdx = col(h, H.flag1099, [ytdIdx]);
  const balIdx = col(h, H.partyBalance, [nameIdx, ytdIdx]);
  const activeIdx = col(h, H.active);

  const nameHeader = h[nameIdx] ?? '';
  const t = ctx.titleText.toLowerCase();
  const is1099Report = /\b1099\b/.test(t);
  const ytdCol = ytdIdx >= 0 ? ytdIdx : is1099Report ? col(h, [/^total$/], [nameIdx]) : -1;
  const vendorHeader = /\b(vendor|supplier|payee)\b/.test(nameHeader) || h.some((c) => /\b(vendor|supplier|payee)\b/.test(c)) || flagIdx >= 0 || ytdCol >= 0;
  const customerHeader = /\b(customer|client)\b/.test(nameHeader) || h.some((c) => /^(customer|client)\b/.test(c));
  const fileN = ctx.fileName.toLowerCase();
  const side = pickSide<'customer' | 'vendor'>(
    'customer',
    'vendor',
    {
      header: vendorHeader && !customerHeader ? 'vendor' : customerHeader && !vendorHeader ? 'customer' : null,
      title: /\b(vendor|supplier|1099|payee)s?\b/.test(t) ? 'vendor' : /\b(customer|client)s?\b/.test(t) ? 'customer' : null,
      file: /(vendor|supplier|1099)/.test(fileN) ? 'vendor' : /(customer|client)/.test(fileN) ? 'customer' : null,
    },
    ctx.expect,
  );
  const entity = side.entity;
  const isVendor = entity === 'vendor';
  if (!side.decided) ctx.warnings.push('We couldn’t tell whether this lists customers or vendors — we filed it as customers. Move it if that’s wrong.');

  const records: StagedPayload[] = [];
  let openBalanceCents = 0;
  let ytdPaidCents = 0;
  let missingTaxId1099 = 0;
  const seen = new Map<string, number>();

  for (let r = ctx.headerIdx + 1; r < ctx.grid.length; r++) {
    const cells = rowCells(ctx.grid, r);
    if (isBlank(cells)) continue;
    const rowNum = r + 1;
    const lbl = firstText(cells);
    const name = get(cells, nameIdx);
    const contactEmpty = [emailIdx, phoneIdx, addrIdx, taxIdx].every((i) => get(cells, i) === '');
    if (dropTotalOrFooter(ctx, rowNum, lbl, contactEmpty)) continue;
    if (!name) {
      ctx.dropped.push({ row: rowNum, reason: `No ${isVendor ? 'vendor' : 'customer'} name on this row — skipped.` });
      continue;
    }
    const address = [get(cells, addrIdx), get(cells, cityIdx), get(cells, stateIdx), get(cells, zipIdx)].filter((v) => v !== '').join(', ');
    const party: StagedParty = {
      name,
      email: get(cells, emailIdx) || null,
      phone: get(cells, phoneIdx) || null,
      taxId: get(cells, taxIdx) || null,
      address: address || null,
    };
    const active = activeIdx >= 0 ? activeFrom(h[activeIdx] ?? '', get(cells, activeIdx)) : undefined;
    if (active !== undefined) party.active = active;
    if (isVendor) {
      const flag = flagIdx >= 0 ? yesNo(get(cells, flagIdx)) : null;
      party.is1099 = flag ?? (is1099Report ? true : null);
      if (ytdCol >= 0) {
        const y = cents(get(cells, ytdCol));
        party.ytdPaidCents = y;
        if (y != null) ytdPaidCents += y;
      }
      if (party.is1099 && !party.taxId) missingTaxId1099 += 1;
    }
    if (balIdx >= 0) {
      const b = cents(get(cells, balIdx));
      if (b != null) openBalanceCents += b;
    }
    const key = normalizePartyName(name);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    records.push({ entity, data: party });
  }

  const dupes = [...seen.values()].filter((n) => n > 1).length;
  if (dupes > 0) ctx.warnings.push(`${plural(dupes, 'name appears', 'names appear')} more than once (ignoring punctuation and Inc / LLC). They’ll be offered for merge, not imported twice.`);
  if (isVendor && missingTaxId1099 > 0) ctx.warnings.push(`${plural(missingTaxId1099, '1099 vendor has', '1099 vendors have')} no tax ID.`);

  const controlTotals: Record<string, number> = { count: records.length };
  if (balIdx >= 0) controlTotals.openBalanceCents = openBalanceCents;
  if (isVendor && ytdCol >= 0) controlTotals.ytdPaidCents = ytdPaidCents;
  if (isVendor) controlTotals.missingTaxId1099Count = missingTaxId1099;

  const kind = isVendor ? (is1099Report ? 'vendor_1099' : 'vendors') : 'customers';
  const label = isVendor
    ? `${is1099Report ? '1099 vendor summary' : 'Vendor list'} · ${plural(records.length, 'vendor')}${ytdCol >= 0 ? ` · ${dollars(ytdPaidCents)} paid` : ''}`
    : `Customer list · ${plural(records.length, 'customer')}`;
  return { entity, kind, confidence: side.decided ? baseScore : baseScore - 0.2, label, records, controlTotals };
}

function parseItems(ctx: Ctx, baseScore: number): ParseOut {
  const { h } = ctx;
  const nameIdx = col(h, H.itemName);
  const skuIdx = col(h, H.sku, [nameIdx]);
  const kindIdx = col(h, H.itemKind, [nameIdx, skuIdx]);
  const incomeIdx = col(h, H.income, [nameIdx, skuIdx, kindIdx]);
  const idIdx = nameIdx >= 0 ? nameIdx : skuIdx;

  const records: StagedPayload[] = [];
  for (let r = ctx.headerIdx + 1; r < ctx.grid.length; r++) {
    const cells = rowCells(ctx.grid, r);
    if (isBlank(cells)) continue;
    const rowNum = r + 1;
    const lbl = firstText(cells);
    if (dropTotalOrFooter(ctx, rowNum, lbl, get(cells, skuIdx) === '' && get(cells, kindIdx) === '')) continue;
    const name = get(cells, idIdx);
    if (!name) {
      ctx.dropped.push({ row: rowNum, reason: 'No item name on this row — skipped.' });
      continue;
    }
    const item: StagedItem = {
      name,
      sku: skuIdx >= 0 && skuIdx !== idIdx ? get(cells, skuIdx) || null : null,
      kind: get(cells, kindIdx) || null,
      incomeAccount: get(cells, incomeIdx) || null,
    };
    records.push({ entity: 'item', data: item });
  }
  return { entity: 'item', kind: 'items', confidence: baseScore, label: `Products & services · ${plural(records.length, 'item')}`, records, controlTotals: { count: records.length } };
}

const CREDIT_NORMAL: ReadonlySet<MeritAccountType> = new Set<MeritAccountType>(['LIABILITY', 'EQUITY', 'REVENUE']);

function parseAccounts(ctx: Ctx, baseScore: number): ParseOut {
  const { h } = ctx;
  const numIdx = col(h, H.acctNumber);
  const nameIdx = col(h, H.acctName, [numIdx]);
  const typeIdx = col(h, H.acctType, [numIdx, nameIdx]);
  const detailIdx = col(h, H.acctDetail, [numIdx, nameIdx, typeIdx]);
  const balIdx = col(h, H.acctBalance, [numIdx, nameIdx]);
  const activeIdx = col(h, H.active, [numIdx, nameIdx, typeIdx]);

  const records: StagedPayload[] = [];
  const byType: Record<string, number> = {};
  let untyped = 0;
  for (let r = ctx.headerIdx + 1; r < ctx.grid.length; r++) {
    const cells = rowCells(ctx.grid, r);
    if (isBlank(cells)) continue;
    const rowNum = r + 1;
    const lbl = firstText(cells);
    if (dropTotalOrFooter(ctx, rowNum, lbl, get(cells, typeIdx) === '' && (numIdx < 0 || get(cells, numIdx) === '' || get(cells, numIdx) === lbl))) continue;
    const rawNum = get(cells, numIdx);
    const rawName = get(cells, nameIdx);
    if (!rawNum && !rawName) {
      ctx.dropped.push({ row: rowNum, reason: 'No account number or name on this row — skipped.' });
      continue;
    }
    let number: string | null = rawNum || null;
    let name = rawName;
    if (!number) {
      const split = splitAccountLabel(rawName);
      number = split.accountNumber;
      name = split.accountName;
    }
    if (!name) name = rawNum;
    const sourceType = get(cells, typeIdx) || null;
    if (typeIdx >= 0 && !sourceType && get(cells, balIdx) === '' && !rawNum && cells.filter((c) => c !== '').length === 1) {
      ctx.dropped.push({ row: rowNum, reason: `“${truncate(lbl)}” is a section heading — skipped.` });
      continue;
    }
    const detailType = get(cells, detailIdx) || null;
    const type = inferAccountType({ number, name, sourceType, detailType });
    const rawBal = balIdx >= 0 ? cents(get(cells, balIdx)) ?? 0 : 0;
    const active = activeIdx >= 0 ? activeFrom(h[activeIdx] ?? '', get(cells, activeIdx)) : undefined;
    const acct: StagedAccount = {
      number: number ?? name,
      name,
      type,
      sourceType,
      detailType,
      active: active ?? true,
      // Account lists show natural-sign balances; staged balances are debit-positive.
      balanceCents: type && CREDIT_NORMAL.has(type) ? -rawBal : rawBal,
    };
    if (type) byType[type] = (byType[type] ?? 0) + 1;
    else untyped += 1;
    records.push({ entity: 'account', data: acct });
  }
  if (untyped > 0) ctx.warnings.push(`${plural(untyped, 'account has', 'accounts have')} no type we could read — you’ll pick it when matching accounts.`);
  if (balIdx >= 0) ctx.warnings.push('Balances on an account list are for reference only; opening balances come from the trial balance.');
  if (typeIdx < 0) ctx.warnings.push('No account type column — types were read from the account numbers and names. Export the list with its Type column if you can.');

  const controlTotals: Record<string, number> = { count: records.length };
  for (const [k, v] of Object.entries(byType)) controlTotals[`${k.toLowerCase()}Count`] = v;
  return { entity: 'account', kind: 'chart_of_accounts', confidence: baseScore, label: `Chart of accounts · ${plural(records.length, 'account')}`, records, controlTotals };
}

function dimKind(header: string, title: string): StagedDimension['kind'] {
  const s = `${header} ${title}`.toLowerCase();
  if (/\b(business unit|business group|cost cent(re|er))s?\b/.test(header)) return 'business_unit';
  if (/\b(department|division)s?\b/.test(header)) return 'department';
  if (/\b(location|store|branch)(es|s)?\b/.test(header)) return 'location';
  if (/\bclass(es)?\b/.test(header)) return 'class';
  if (/\b(business unit|business group|cost cent(re|er))s?\b/.test(s)) return 'business_unit';
  if (/\b(department|division)s?\b/.test(s)) return 'department';
  if (/\b(location|store|branch)(es|s)?\b/.test(s)) return 'location';
  return 'class';
}

function parseDimensions(ctx: Ctx, baseScore: number): ParseOut {
  const { h } = ctx;
  const nameIdx = col(h, [...H.dim, /^(full name|name)$/]);
  const fullIdx = col(h, [/^(full name|class full name)$/], [nameIdx]);
  const countIdx = col(h, [/^(transactions|transaction count|txn count|count|# of transactions)$/]);
  const kind = dimKind(h[nameIdx] ?? '', ctx.titleText);

  const records: StagedPayload[] = [];
  for (let r = ctx.headerIdx + 1; r < ctx.grid.length; r++) {
    const cells = rowCells(ctx.grid, r);
    if (isBlank(cells)) continue;
    const rowNum = r + 1;
    const lbl = firstText(cells);
    if (dropTotalOrFooter(ctx, rowNum, lbl, false)) continue;
    const name = get(cells, fullIdx) || get(cells, nameIdx);
    if (!name) {
      ctx.dropped.push({ row: rowNum, reason: 'No name on this row — skipped.' });
      continue;
    }
    const dim: StagedDimension = { name, kind };
    if (countIdx >= 0) dim.txnCount = intOrNull(get(cells, countIdx));
    records.push({ entity: 'dimension', data: dim });
  }
  const noun: Record<StagedDimension['kind'], [string, string]> = {
    class: ['class', 'classes'],
    location: ['location', 'locations'],
    department: ['department', 'departments'],
    business_unit: ['business unit', 'business units'],
  };
  const [one, many] = noun[kind];
  return {
    entity: 'dimension',
    kind: 'dimensions',
    confidence: baseScore,
    label: `${many.charAt(0).toUpperCase()}${many.slice(1)} · ${plural(records.length, one, many)}`,
    records,
    controlTotals: { count: records.length },
  };
}

function parseJobs(ctx: Ctx, baseScore: number): ParseOut {
  const { h } = ctx;
  const numIdx = col(h, H.jobNumber);
  const nameIdx = col(h, [...H.jobNameSpecific, ...H.jobNameLoose], [numIdx]);
  const custIdx = col(h, H.jobCustomer, [numIdx, nameIdx]);
  const statusIdx = col(h, H.jobStatus);
  const revisedIdx = col(h, H.contractRevised);
  const origIdx = col(h, H.contractOriginal, [revisedIdx]);
  const coIdx = col(h, H.changeOrders);
  const costIdx = col(h, H.cost);
  const billedIdx = col(h, H.billed);
  const earnedIdx = col(h, H.earned);
  const ouIdx = col(h, H.overUnder);
  const underIdx = col(h, H.under, [ouIdx]);
  const overIdx = col(h, H.over, [ouIdx]);
  const retIdx = col(h, H.retainage);
  const ouHeader = h[ouIdx] ?? '';
  const positiveIsOver = ouIdx >= 0 && ouHeader.indexOf('over') < ouHeader.indexOf('under');
  const addCOs = revisedIdx < 0 && origIdx >= 0 && coIdx >= 0;

  const records: StagedPayload[] = [];
  const tot = { contract: 0, billed: 0, cost: 0, unbilled: 0, bie: 0, retainage: 0, co: 0 };
  for (let r = ctx.headerIdx + 1; r < ctx.grid.length; r++) {
    const cells = rowCells(ctx.grid, r);
    if (isBlank(cells)) continue;
    const rowNum = r + 1;
    const lbl = firstText(cells);
    if (dropTotalOrFooter(ctx, rowNum, lbl, numIdx < 0 || get(cells, numIdx) === '' || get(cells, numIdx) === lbl)) continue;
    const number = get(cells, numIdx) || null;
    const name = get(cells, nameIdx) || number || '';
    if (!name) {
      ctx.dropped.push({ row: rowNum, reason: 'No job number or name on this row — skipped.' });
      continue;
    }
    const money = (i: number): number | null => (i >= 0 && get(cells, i) !== '' ? cents(get(cells, i)) : i >= 0 ? 0 : null);
    const co = money(coIdx);
    let contract = revisedIdx >= 0 ? money(revisedIdx) : money(origIdx);
    if (addCOs && contract != null && co != null) contract += co;
    const billed = money(billedIdx);
    const cost = money(costIdx);
    let unbilled: number | null = null;
    let bie: number | null = null;
    if (underIdx >= 0 || overIdx >= 0) {
      unbilled = underIdx >= 0 ? Math.abs(money(underIdx) ?? 0) : 0;
      bie = overIdx >= 0 ? Math.abs(money(overIdx) ?? 0) : 0;
    } else if (ouIdx >= 0) {
      const v = money(ouIdx) ?? 0;
      const over = positiveIsOver ? v : -v;
      bie = over > 0 ? over : 0;
      unbilled = over < 0 ? -over : 0;
    } else if (earnedIdx >= 0 && billed != null) {
      const diff = billed - (money(earnedIdx) ?? 0);
      bie = diff > 0 ? diff : 0;
      unbilled = diff < 0 ? -diff : 0;
    }
    const job: StagedJob = {
      number,
      name,
      customer: get(cells, custIdx) || null,
      status: get(cells, statusIdx) || null,
      contractCents: contract,
      billedCents: billed,
      costCents: cost,
      unbilledCents: unbilled,
      billingsInExcessCents: bie,
    };
    tot.contract += contract ?? 0;
    tot.billed += billed ?? 0;
    tot.cost += cost ?? 0;
    tot.unbilled += unbilled ?? 0;
    tot.bie += bie ?? 0;
    tot.co += co ?? 0;
    tot.retainage += money(retIdx) ?? 0;
    records.push({ entity: 'job', data: job });
  }

  if (addCOs) ctx.warnings.push('Contract value = the Contract column plus Change orders. Confirm on the WIP card if the Contract column already includes them.');
  if (ouIdx < 0 && underIdx < 0 && overIdx < 0 && earnedIdx < 0) {
    ctx.warnings.push('No earned-revenue or over/under-billing column — under- and over-billing are worked out on the WIP card, not guessed here.');
  }
  const wipShape = retIdx >= 0 || earnedIdx >= 0 || ouIdx >= 0 || underIdx >= 0 || overIdx >= 0 || /\bwip\b|work in progress/i.test(`${ctx.titleText} ${ctx.fileName}`);

  const controlTotals: Record<string, number> = {
    count: records.length,
    contractCents: tot.contract,
    billedCents: tot.billed,
    costCents: tot.cost,
    unbilledCents: tot.unbilled,
    billingsInExcessCents: tot.bie,
  };
  if (coIdx >= 0) controlTotals.changeOrdersCents = tot.co;
  if (retIdx >= 0) controlTotals.retainageCents = tot.retainage;

  return {
    entity: 'job',
    kind: wipShape ? 'wip' : 'jobs',
    confidence: baseScore,
    label: `${wipShape ? 'WIP schedule' : 'Job list'}${ctx.asOf ? ` as of ${longDate(ctx.asOf)}` : ''} · ${plural(records.length, 'open job')} · ${dollars(tot.cost)} cost to date`,
    records,
    controlTotals,
  };
}

function parseBankTable(ctx: Ctx, baseScore: number): ParseOut {
  const { h } = ctx;
  const labelIdx = col(h, H.bankLabel);
  const glIdx = col(h, H.bankGl, [labelIdx]);
  const balIdx = col(h, H.stmtBal);
  const dateIdx = col(h, H.stmtDate);
  const recIdx = col(h, H.reconciled, [dateIdx]);
  const cntIdx = col(h, H.unclCount);
  const totIdx = col(h, H.unclTotal, [cntIdx]);
  const oldIdx = col(h, H.oldestUncl);

  const records: StagedPayload[] = [];
  let statementCents = 0;
  let unclearedCents = 0;
  for (let r = ctx.headerIdx + 1; r < ctx.grid.length; r++) {
    const cells = rowCells(ctx.grid, r);
    if (isBlank(cells)) continue;
    const rowNum = r + 1;
    const lbl = firstText(cells);
    if (dropTotalOrFooter(ctx, rowNum, lbl, get(cells, glIdx) === '' && get(cells, dateIdx) === '')) continue;
    const label = get(cells, labelIdx);
    const bal = cents(get(cells, balIdx));
    if (!label || bal == null || get(cells, balIdx) === '') {
      ctx.dropped.push({ row: rowNum, reason: label ? `“${truncate(label)}” has no statement balance — skipped.` : 'No account on this row — skipped.' });
      continue;
    }
    const glRaw = get(cells, glIdx);
    const glNumber = glRaw ? (splitAccountLabel(glRaw).accountNumber ?? glRaw) : splitAccountLabel(label).accountNumber;
    const stmtDate = parseDate(get(cells, dateIdx)) ?? ctx.asOf;
    const bb: StagedBankBalance = {
      label,
      glAccountNumber: glNumber,
      statementBalanceCents: bal,
      statementDate: stmtDate,
      lastReconciledDate: parseDate(get(cells, recIdx)),
    };
    if (cntIdx >= 0) bb.unclearedCount = intOrNull(get(cells, cntIdx));
    if (totIdx >= 0) {
      bb.unclearedTotalCents = cents(get(cells, totIdx));
      unclearedCents += bb.unclearedTotalCents ?? 0;
    }
    if (oldIdx >= 0) bb.oldestUnclearedDate = parseDate(get(cells, oldIdx));
    statementCents += bal;
    records.push({ entity: 'bank_balance', data: bb });
  }
  if (recIdx < 0) ctx.warnings.push('No “reconciled through” date — the bank check will ask when each account was last reconciled.');
  const controlTotals: Record<string, number> = { count: records.length, statementBalanceCents: statementCents };
  if (totIdx >= 0) controlTotals.unclearedTotalCents = unclearedCents;
  return {
    entity: 'bank_balance',
    kind: 'bank_balances',
    confidence: baseScore,
    label: `Bank balances · ${plural(records.length, 'account')} · ${dollars(statementCents)} per statements`,
    records,
    controlTotals,
  };
}

/**
 * A single-account RECONCILIATION REPORT (QuickBooks "Reconciliation report", Xero "Bank
 * Reconciliation"): key/value summary rows, not a table. Returns null when the grid isn't one.
 */
type ReconOut = ParseOut & { asOf: string | null; dropped: Dropped[] };

function parseReconciliationReport(grid: Grid): ReconOut | null {
  const limit = Math.min(grid.length, 80);
  let endRow = -1;
  for (let r = 0; r < limit; r++) {
    if (/^(statement ending balance|closing balance per statement|balance per bank statement|statement balance)$/i.test(firstText(rowCells(grid, r)))) {
      endRow = r;
      break;
    }
  }
  if (endRow < 0) return null;

  const lastAmount = (cells: string[]): number | null => {
    for (let i = cells.length - 1; i > 0; i--) {
      const v = cells[i];
      if (v && /\d/.test(v)) {
        const c = cents(v);
        if (c != null) return c;
      }
    }
    return null;
  };
  const statement = lastAmount(rowCells(grid, endRow));
  if (statement == null) return null;

  let label = '';
  let periodEnd: string | null = null;
  const dropped: Dropped[] = [];
  let uncleared: number | null = null;
  let unclearedParts = 0;
  let unclearedCount: number | null = null;

  for (let r = 0; r < Math.min(grid.length, 400); r++) {
    const cells = rowCells(grid, r);
    if (isBlank(cells)) continue;
    const text = firstText(cells);
    const pe = text.match(/^(.*?),?\s*period ending\s+(.+)$/i);
    if (pe && !periodEnd) {
      label = pe[1].trim();
      periodEnd = parseDate(pe[2]);
    }
    const asAt = text.match(/^(?:bank reconciliation|reconciliation report)?\s*(?:as (?:of|at))\s+(.+)$/i);
    if (asAt && !periodEnd) periodEnd = parseDate(asAt[1]);
    if (/^uncleared transactions as of/i.test(text)) {
      uncleared = lastAmount(cells);
      if (!periodEnd) periodEnd = parseDate(text.replace(/^uncleared transactions as of/i, ''));
    } else if (/^uncleared (checks|deposits|payments)/i.test(text)) {
      unclearedParts += lastAmount(cells) ?? 0;
      const n = text.match(/\((\d+)\)/);
      if (n) unclearedCount = (unclearedCount ?? 0) + Number(n[1]);
    }
    if (r !== endRow) dropped.push({ row: r + 1, reason: `“${truncate(text)}” — reconciliation summary line, read for the statement balance and uncleared items.` });
  }
  if (!label) {
    const titled = grid.slice(0, endRow).map((row) => firstText((row ?? []).map((c) => String(c ?? '').trim()))).find((t) => /\b(checking|savings|bank|account|card|\d{3,})\b/i.test(t) && !/reconciliation/i.test(t));
    label = titled ? titled.replace(/,?\s*period ending.*$/i, '').trim() : 'Bank account';
  }
  const unclearedTotal = uncleared ?? (unclearedParts !== 0 ? unclearedParts : null);
  const bb: StagedBankBalance = {
    label,
    glAccountNumber: splitAccountLabel(label).accountNumber,
    statementBalanceCents: statement,
    statementDate: periodEnd,
    lastReconciledDate: periodEnd,
    unclearedCount,
    unclearedTotalCents: unclearedTotal,
  };
  const controlTotals: Record<string, number> = { count: 1, statementBalanceCents: statement };
  if (unclearedTotal != null) controlTotals.unclearedTotalCents = unclearedTotal;
  return {
    entity: 'bank_balance',
    kind: 'reconciliation',
    confidence: 0.9,
    label: `Bank reconciliation · ${label}${periodEnd ? ` · period ending ${longDate(periodEnd)}` : ''} · ${dollars(statement)} per statement`,
    records: [{ entity: 'bank_balance', data: bb }],
    controlTotals,
    asOf: periodEnd,
    dropped,
  };
}

function runParser(kind: DetectorKind, ctx: Ctx, score: number): ParseOut | { error: string } {
  switch (kind) {
    case 'tb': return parseTb(ctx);
    case 'aging': return parseAging(ctx, score);
    case 'party': return parseParty(ctx, score);
    case 'item': return parseItems(ctx, score);
    case 'account': return parseAccounts(ctx, score);
    case 'dimension': return parseDimensions(ctx, score);
    case 'job': return parseJobs(ctx, score);
    case 'bank': return parseBankTable(ctx, score);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

function unrecognized(warnings: string[], asOf: string | null = null, parser = 'none', label = 'We couldn’t recognize this file', dropped: Dropped[] = []): RecognizedFile {
  return { entity: null, confidence: 0, parser, label, records: [], controlTotals: {}, asOfHint: asOf, dropped, warnings };
}

/** Recognize ONE grid (one sheet / CSV) and normalize it into staged payloads. Pure, rules only. */
export function recognizeGrid(gridIn: string[][], opts: RecognizeOptions = {}): RecognizedFile {
  const grid: Grid = (gridIn ?? []).map((row) => (row ?? []).map((c) => (c == null ? '' : String(c))));
  const expect = opts.expectEntity ?? null;
  const fileName = opts.fileName ?? '';
  const prefix = prefixFor(opts.systemId, grid);
  const expectHint = expect ? ` For this slot we expect ${ENTITY_NOUN[expect].a}; the recipe above names the exact report.` : '';

  if (grid.every((row) => isBlank(row.map((c) => c.trim())))) {
    return unrecognized([`This file is empty.${expectHint}`]);
  }

  // 1. A single-account reconciliation report (key/value summary, not a table).
  const recon = parseReconciliationReport(grid);
  if (recon) {
    const warnings: string[] = [];
    if (expect && expect !== 'bank_balance') warnings.push(mismatchWarning('bank_balance', expect));
    if (recon.controlTotals.unclearedTotalCents == null) warnings.push('No uncleared-items total on this report — the bank check will treat the statement balance as fully cleared.');
    return {
      entity: 'bank_balance',
      confidence: round2(recon.confidence + (expect === 'bank_balance' ? 0.05 : 0)),
      parser: `${prefix}.${recon.kind} v1`,
      label: recon.label,
      records: recon.records,
      controlTotals: recon.controlTotals,
      asOfHint: recon.asOf,
      dropped: recon.dropped,
      warnings,
    };
  }

  // 2. Score every candidate header row against every detector.
  const best = new Map<DetectorKind, { score: number; row: number }>();
  const limit = Math.min(grid.length, SCAN_ROWS);
  for (let r = 0; r < limit; r++) {
    const raw = rowCells(grid, r);
    if (isBlank(raw) || looksLikeDataRow(raw)) continue;
    const h = raw.map(normHeader);
    const title = titleRowsBefore(grid, r).text;
    for (const kind of DETECTOR_ORDER) {
      const s = scoreRow(kind, h, title);
      const prev = best.get(kind);
      if (s > 0 && (!prev || s > prev.score)) best.set(kind, { score: s, row: r });
    }
  }

  const ranked = DETECTOR_ORDER.filter((k) => best.has(k)).sort((a, b) => (best.get(b)?.score ?? 0) - (best.get(a)?.score ?? 0));
  let chosen: DetectorKind | null = ranked[0] ?? null;
  // expectEntity breaks near-ties (within 0.1).
  if (chosen && expect) {
    const top = best.get(chosen)?.score ?? 0;
    const alt = ranked.find((k) => DETECTOR_ENTITIES[k].includes(expect) && (best.get(k)?.score ?? 0) >= Math.max(0.5, top - 0.1));
    if (alt) chosen = alt;
  }

  // 3. A General Ledger DETAIL export is not a trial balance (and not a list): say so plainly.
  const chosenScore = chosen ? best.get(chosen)?.score ?? 0 : 0;
  if (chosen !== 'aging' && (!chosen || chosen === 'tb' || chosenScore < 0.8) && looksLikeGeneralLedgerDetail(grid)) {
    return unrecognized([GL_DETAIL_NOT_TB_MESSAGE], null, `${prefix}.gl_detail v1`, 'General Ledger detail — transaction history, not opening balances');
  }

  if (!chosen) {
    return unrecognized([
      `We couldn’t tell what this file is from its column headings.${expectHint} If it came from a system we don’t have a recipe for, map its columns by hand and the map is saved for next time.`,
    ]);
  }

  const headerIdx = best.get(chosen)?.row ?? 0;
  const title = titleRowsBefore(grid, headerIdx);
  const ctx: Ctx = {
    grid,
    headerIdx,
    h: rowCells(grid, headerIdx).map(normHeader),
    titleText: title.text,
    fileName,
    prefix,
    expect,
    asOf: findAsOf(title.lines),
    dropped: [],
    warnings: [],
  };
  if (chosen !== 'tb') ctx.dropped.push(...title.dropped, headerDropped(headerIdx));

  const out = runParser(chosen, ctx, chosenScore);

  if ('error' in out) return unrecognized([out.error], ctx.asOf, `${prefix}.tb v1`, 'We couldn’t read this trial balance', ctx.dropped);

  if (out.records.length === 0) {
    return unrecognized(
      [`We found the column headings of ${ENTITY_NOUN[out.entity].a} but no rows under them.${expectHint}`],
      ctx.asOf,
      `${prefix}.${out.kind} v1`,
      'No rows found',
      ctx.dropped,
    );
  }

  const warnings = [...ctx.warnings];
  let confidence = out.confidence;
  if (expect && expect !== out.entity) {
    warnings.unshift(mismatchWarning(out.entity, expect));
    confidence -= 0.05;
  } else if (expect === out.entity) {
    confidence += 0.05;
  }

  return {
    entity: out.entity,
    confidence: round2(confidence),
    parser: `${prefix}.${out.kind} v1`,
    label: out.label,
    records: out.records,
    controlTotals: out.controlTotals,
    asOfHint: ctx.asOf,
    dropped: ctx.dropped.sort((a, b) => a.row - b.row),
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Account type inference + party-name normalization
// ─────────────────────────────────────────────────────────────────────────────

const words = (s: string): string =>
  s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Source type labels (QuickBooks, Xero, Sage, NetSuite …) and detail types → our type. Order matters. */
const TYPE_RULES: [RegExp, MeritAccountType][] = [
  [/\b(other income|other expenses?|other revenue|non operating|nonoperating|other comprehensive)\b/, 'OTHER'],
  [/\b(cost of goods sold|cost of sales|cogs|cost of revenue|direct costs?|cost of labor|job costs?)\b/, 'COGS'],
  [/\b(accumulated depreciation|accounts receivable|receivables?|bank|cash|checking|savings|undeposited|current assets?|fixed assets?|other assets?|non current assets?|noncurrent assets?|inventory|prepayments?|prepaid|assets?|allowance for bad debts)\b/, 'ASSET'],
  [/\b(accounts payable|payables?|credit cards?|current liabilit(y|ies)|long term liabilit(y|ies)|non current liabilit(y|ies)|liabilit(y|ies)|loans? payable|notes? payable|line of credit|accrued|payroll liabilit(y|ies)|wages payable|deferred revenue|unearned)\b/, 'LIABILITY'],
  [/\b(equity|retained earnings|owner s? equity|capital|distributions?|draws?|opening balance equity)\b/, 'EQUITY'],
  [/\b(income|revenue|sales|fees earned)\b/, 'REVENUE'],
  [/\b(expenses?|overheads?|depreciation|amortization|operating)\b/, 'OPEX'],
];

/** High-precision name patterns that beat the number range. */
const NAME_STRONG: [RegExp, MeritAccountType][] = [
  [/\b(accounts receivable|a r)\b/, 'ASSET'],
  [/\b(accounts payable|a p)\b/, 'LIABILITY'],
  [/\b(retained earnings|opening balance equity|owner s? (equity|draws?|contributions?)|members? (equity|draws?|contributions?|distributions?)|shareholder distributions?|partners? (capital|equity))\b/, 'EQUITY'],
  [/\b(undeposited funds|petty cash|accumulated depreciation|prepaid)\b/, 'ASSET'],
  [/\b(cost of (goods sold|sales|revenue)|cogs)\b/, 'COGS'],
];

/** Weaker name keywords, after the number range. */
const NAME_WEAK: [RegExp, MeritAccountType][] = [
  [/\b(interest income|other income|other expense|gain on|loss on|interest expense)\b/, 'OTHER'],
  [/\b(payable|accrued|loans?|notes? payable|line of credit|credit card|deferred|unearned|liabilit(y|ies)|customer deposits?)\b/, 'LIABILITY'],
  [/\b(receivable)\b/, 'ASSET'],
  [/\b(expenses?|fees|charges|rent|utilities|insurance|wages|salaries|supplies|repairs|maintenance|advertising|depreciation|amortization|travel|meals|telephone|dues|subscriptions|postage|licenses|taxes)\b/, 'OPEX'],
  [/\b(checking|savings|cash|bank|inventory|equipment|vehicles?|furniture|buildings?|land|leasehold|computers?|security deposits?)\b/, 'ASSET'],
  [/\b(equity|capital|distributions?|draws?)\b/, 'EQUITY'],
  [/\b(income|revenue|sales)\b/, 'REVENUE'],
];

const RANGE: Record<string, MeritAccountType> = { '1': 'ASSET', '2': 'LIABILITY', '3': 'EQUITY', '4': 'REVENUE', '5': 'COGS', '6': 'OPEX', '7': 'OTHER', '8': 'OTHER', '9': 'OTHER' };

const firstMatch = (text: string, rules: readonly [RegExp, MeritAccountType][]): MeritAccountType | null => {
  if (!text) return null;
  for (const [re, t] of rules) if (re.test(text)) return t;
  return null;
};

/**
 * Our best reading of an account's type: the source's type label → its detail type → strong name
 * patterns (A/R, A/P, retained earnings …) → the number range (1xxx asset … 6xxx opex, 7–9 other) →
 * weaker name keywords. null when nothing is convincing (the human picks at mapping).
 */
export function inferAccountType(input: { number: string | null; name: string; sourceType?: string | null; detailType?: string | null }): MeritAccountType | null {
  const fromType = firstMatch(words(input.sourceType ?? ''), TYPE_RULES);
  if (fromType) return fromType;
  const fromDetail = firstMatch(words(input.detailType ?? ''), TYPE_RULES);
  if (fromDetail) return fromDetail;
  const name = words(input.name ?? '');
  const strong = firstMatch(name, NAME_STRONG);
  if (strong) return strong;
  const num = (input.number ?? '').trim().match(/^(\d)\d{2,}/);
  if (num && RANGE[num[1]]) return RANGE[num[1]];
  return firstMatch(name, NAME_WEAK);
}

const PARTY_SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'pllc', 'co', 'corp', 'corporation', 'ltd', 'limited', 'company', 'lp', 'llp', 'pc']);

/** Lower-case, strip punctuation and Inc / LLC / Co / Corp / Ltd suffixes ("Menards, Inc." → "menards"). */
export function normalizePartyName(name: string): string {
  const base = (name ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const tokens = base.split(' ').filter((t) => t !== '');
  if (tokens[0] === 'the' && tokens.length > 1) tokens.shift();
  while (tokens.length > 1 && PARTY_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}
