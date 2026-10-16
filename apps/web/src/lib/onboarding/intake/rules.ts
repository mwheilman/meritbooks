/**
 * Smart Intake — DETERMINISTIC classifier (FPB principle 10: "works with AI off").
 *
 * When the AI gateway is unavailable, over budget, or fails, every dropped file still
 * gets a best guess from plain rules:
 *   1. CONTENT SNIFF for spreadsheets / CSV — keywords in the first rows (QuickBooks
 *      title rows included): Account+Debit+Credit → trial balance; Customer + Balance/Due
 *      → open A/R; Vendor + Balance/Due → open A/P; Budget or ≥6 month columns → budget …
 *   2. FILE NAME — articles / operating agreement / EIN / SS-4 / CP-575 / note / loan /
 *      promissory / budget / org chart / expense policy …
 * The two are merged (agreement boosts confidence). Pure and dependency-free — no
 * I/O — so it is unit-tested directly (rules.test.ts) and safe to import anywhere.
 *
 * Canon boundary: like the AI path, this only PROPOSES what a file is. The user can
 * always correct the type, and the receiving parser still shows a review before
 * anything is saved.
 */

import type { IntakeDocType, ClassificationSource } from './types';

export interface RuleInput {
  fileName: string;
  /**
   * Spreadsheet cells from the first rows (title rows + header row), any order. Empty
   * / absent for PDFs and images, where only the file name is available.
   */
  cells?: string[] | null;
}

export interface RuleResult {
  docType: IntakeDocType;
  /** 0–1. 0 when nothing matched (docType UNKNOWN). */
  confidence: number;
  /** Plain-English reason shown on the card ("Has Debit and Credit columns"). */
  reason: string;
}

const NONE: RuleResult = { docType: 'UNKNOWN', confidence: 0, reason: '' };

/** Lower-case and fold separators so `Acme_EIN-letter.pdf` reads `acme ein letter pdf`. */
export function normalizeName(fileName: string): string {
  return fileName
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .replace(/[_\-.+()[\]{}]+/g, ' ')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── 1. File-name rules (ordered: most specific first) ───────────────────────

interface NameRule { re: RegExp; docType: IntakeDocType; confidence: number; reason: string }

const NAME_RULES: NameRule[] = [
  { re: /\b(cp ?575|ss ?4|147 ?c|ein|employer identification)\b/, docType: 'EIN_LETTER', confidence: 0.8, reason: 'File name mentions the EIN / CP-575 / SS-4' },
  { re: /\b(operating agreement|llc agreement|partnership agreement|shareholders? agreement|bylaws|op agreement)\b/, docType: 'OPERATING_AGREEMENT', confidence: 0.8, reason: 'File name says operating agreement' },
  { re: /\b(articles of (organization|incorporation)|certificate of (formation|incorporation|organization)|articles|formation|incorporation)\b/, docType: 'FORMATION_DOC', confidence: 0.75, reason: 'File name says articles / formation' },
  { re: /\b(trial balance|tb)\b/, docType: 'TRIAL_BALANCE', confidence: 0.8, reason: 'File name says trial balance' },
  { re: /\b(general ledger|gl detail|gl)\b/, docType: 'GENERAL_LEDGER', confidence: 0.7, reason: 'File name says general ledger' },
  { re: /\b(org chart|orgchart|organization chart|organizational chart|reporting lines)\b/, docType: 'ORG_CHART', confidence: 0.85, reason: 'File name says org chart' },
  { re: /\b(expense|travel|reimbursement|spending|approval|t ?& ?e|purchasing) polic(y|ies)\b/, docType: 'EXPENSE_POLICY', confidence: 0.85, reason: 'File name says expense / approval policy' },
  { re: /\b(promissory|loan|note payable|credit agreement|line of credit|loc|sba|mortgage|term note|note)\b/, docType: 'LOAN', confidence: 0.7, reason: 'File name mentions a loan / note' },
  { re: /\b(budget|forecast)\b/, docType: 'BUDGET', confidence: 0.75, reason: 'File name says budget' },
  { re: /\b(a ?r aging|ar aging|receivables?|open invoices|customer balances?|aged receivables)\b/, docType: 'AR_AGING', confidence: 0.75, reason: 'File name says receivables / A/R aging' },
  { re: /\b(a ?p aging|ap aging|payables?|unpaid bills|vendor balances?|aged payables)\b/, docType: 'AP_AGING', confidence: 0.75, reason: 'File name says payables / A/P aging' },
  { re: /\b(wip|work in progress|job cost|jobs schedule)\b/, docType: 'WIP_SCHEDULE', confidence: 0.75, reason: 'File name says WIP' },
  { re: /\b(customers?|clients?|crm|contacts|hubspot|salesforce|pipedrive)\b/, docType: 'CUSTOMER_LIST', confidence: 0.65, reason: 'File name says customers / CRM' },
  { re: /\b(vendors?|suppliers?)\b/, docType: 'VENDOR_LIST', confidence: 0.65, reason: 'File name says vendors' },
  { re: /\bw ?9\b/, docType: 'W9', confidence: 0.8, reason: 'File name says W-9' },
  { re: /\b(coi|certificate of insurance|acord)\b/, docType: 'COI', confidence: 0.75, reason: 'File name says certificate of insurance' },
  { re: /\blease\b/, docType: 'LEASE', confidence: 0.7, reason: 'File name says lease' },
  { re: /\b(payroll|pay register|paystubs?)\b/, docType: 'PAYROLL_REGISTER', confidence: 0.7, reason: 'File name says payroll' },
  { re: /\b(bank statement|statement)\b/, docType: 'BANK_STATEMENT', confidence: 0.6, reason: 'File name says statement' },
  { re: /\b(insurance|declarations|dec page|policy)\b/, docType: 'INSURANCE_POLICY', confidence: 0.55, reason: 'File name says insurance / policy' },
  { re: /\b(subscription|order form)\b/, docType: 'SUBSCRIPTION', confidence: 0.55, reason: 'File name says subscription' },
  { re: /\b(invoice|bill)\b/, docType: 'BILL', confidence: 0.5, reason: 'File name says invoice / bill' },
  { re: /\b(contract|msa|sow|agreement)\b/, docType: 'CUSTOMER_CONTRACT', confidence: 0.45, reason: 'File name says contract / agreement' },
];

export function classifyByFileName(fileName: string): RuleResult {
  const n = normalizeName(fileName);
  if (!n) return NONE;
  for (const r of NAME_RULES) {
    if (r.re.test(n)) return { docType: r.docType, confidence: r.confidence, reason: r.reason };
  }
  return NONE;
}

// ── 2. Content sniff (spreadsheets / CSV) ───────────────────────────────────

const MONTH_RE = /^(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b|^(m(onth)? ?\d{1,2}|p(eriod)? ?\d{1,2})$|^\d{4}[-/]\d{1,2}$|^\d{1,2}[-/]\d{4}$/;

function norm(cell: string): string {
  return cell.toLowerCase().replace(/[_\s]+/g, ' ').trim();
}

/** Count distinct month-like column labels (Jan…Dec, 2026-01, M1, Period 3…). */
export function countMonthColumns(cells: string[]): number {
  const seen = new Set<string>();
  for (const c of cells) {
    const v = norm(c);
    if (v.length > 0 && v.length <= 20 && MONTH_RE.test(v)) seen.add(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(v) ? v.slice(0, 3) : v);
  }
  return seen.size;
}

export function classifyByContent(cellsIn: string[]): RuleResult {
  const cells = cellsIn.map(norm).filter((c) => c.length > 0 && c.length <= 80);
  if (cells.length === 0) return NONE;
  const text = ` ${cells.join(' | ')} `;
  const has = (re: RegExp): boolean => re.test(text);

  const debit = has(/\bdebits?\b|\bdr\b/);
  const credit = has(/\bcredits?\b|\bcr\b/);
  const account = has(/\baccounts?\b|\bacct\b|\bgl code\b/);
  const customer = has(/\bcustomers?\b|\bclients?\b|\bbill to\b/);
  const vendor = has(/\bvendors?\b|\bsuppliers?\b|\bpayee\b/);
  const dueish = has(/\bbalance\b|\bdue\b|\bopen\b|\bamount due\b|\bpast due\b|\baging\b|\b1 ?- ?30\b|\b31 ?- ?60\b|\bdays\b|\bcurrent\b/);
  const contactish = has(/\be-?mail\b|\bphone\b|\baddress\b|\bcity\b|\bzip\b|\bwebsite\b/);
  const months = countMonthColumns(cells);

  // Explicit report titles win (QuickBooks puts them in the first rows).
  if (has(/\btrial balance\b/)) return { docType: 'TRIAL_BALANCE', confidence: 0.95, reason: 'Titled "Trial Balance"' };
  if (has(/\bgeneral ledger\b/) && !has(/\btrial balance\b/)) return { docType: 'GENERAL_LEDGER', confidence: 0.85, reason: 'Titled "General Ledger"' };
  if (has(/\ba\/?r aging\b|\breceivables? aging\b|\baged receivables\b|\bopen invoices\b/)) return { docType: 'AR_AGING', confidence: 0.92, reason: 'Titled A/R aging / open invoices' };
  if (has(/\ba\/?p aging\b|\bpayables? aging\b|\baged payables\b|\bunpaid bills\b/)) return { docType: 'AP_AGING', confidence: 0.92, reason: 'Titled A/P aging / unpaid bills' };
  if (has(/\bbudget\b/)) return { docType: 'BUDGET', confidence: months >= 6 ? 0.92 : 0.85, reason: 'Mentions "Budget"' };

  // Payroll / WIP / org chart signatures.
  if (has(/\bgross pay\b|\bnet pay\b|\bgross wages\b/)) return { docType: 'PAYROLL_REGISTER', confidence: 0.85, reason: 'Has gross / net pay columns' };
  const wipHits = [/\bcontract (amount|value|price)\b/, /\b(percent|%) complete\b/, /\bbilled to date\b/, /\bcosts? to date\b/, /\bestimated (total )?cost\b/, /\bover ?\/? ?under ?billing/]
    .filter((re) => has(re)).length;
  if (wipHits >= 2) return { docType: 'WIP_SCHEDULE', confidence: 0.85, reason: 'Has contract / % complete / billed-to-date columns' };
  if (has(/\breports? to\b|\bmanager\b|\bsupervisor\b/) && has(/\btitle\b|\bemployee\b|\bposition\b|\brole\b/)) {
    return { docType: 'ORG_CHART', confidence: 0.8, reason: 'Has employee and reports-to columns' };
  }

  // Ledger shapes: a GL detail has dated transactions + memo/split; a TB has accounts + Dr/Cr.
  if (debit && credit) {
    const detail = has(/\bdate\b/) && has(/\bmemo\b|\bsplit\b|\btransaction type\b|\bnum\b|\bdescription\b/);
    if (detail) return { docType: 'GENERAL_LEDGER', confidence: 0.75, reason: 'Dated Debit / Credit lines with memos' };
    return { docType: 'TRIAL_BALANCE', confidence: account ? 0.9 : 0.8, reason: 'Has Account, Debit and Credit columns' };
  }

  // Sub-ledgers: customers / vendors with balances = open A/R / A/P; with contacts = lists.
  if (customer && !vendor) {
    if (dueish) return { docType: 'AR_AGING', confidence: 0.8, reason: 'Customers with balances due' };
    return { docType: 'CUSTOMER_LIST', confidence: contactish ? 0.8 : 0.65, reason: 'A list of customers' };
  }
  if (vendor && !customer) {
    if (dueish) return { docType: 'AP_AGING', confidence: 0.8, reason: 'Vendors with balances due' };
    return { docType: 'VENDOR_LIST', confidence: contactish ? 0.8 : 0.65, reason: 'A list of vendors' };
  }

  // Month columns with accounts (and no Dr/Cr) read as a budget / forecast.
  if (months >= 6) return { docType: 'BUDGET', confidence: account ? 0.75 : 0.6, reason: `${months} month columns` };

  // Bank export: deposits / withdrawals, or date + description + amount + running balance.
  if (has(/\bwithdrawals?\b|\bdeposits?\b/) || (has(/\bdate\b/) && has(/\bdescription\b/) && has(/\bamount\b/) && has(/\bbalance\b/))) {
    return { docType: 'BANK_STATEMENT', confidence: 0.65, reason: 'Dated deposits / withdrawals' };
  }

  // CRM export: deals / leads / contacts with emails.
  if ((has(/\bdeals?\b|\bleads?\b|\bcontacts?\b|\blifecycle stage\b|\bopportunit(y|ies)\b/) || has(/\bcompany( name)?\b/)) && contactish) {
    return { docType: 'CUSTOMER_LIST', confidence: 0.6, reason: 'Looks like a CRM / contacts export' };
  }

  // A two-column "Account | Balance" export is still a trial balance.
  if (account && has(/\bbalance\b|\bamount\b/)) return { docType: 'TRIAL_BALANCE', confidence: 0.6, reason: 'Accounts with balances' };

  return NONE;
}

// ── 3. Merge ────────────────────────────────────────────────────────────────

/**
 * Classify by rules: content (when cells are available) + file name, merged. Agreement
 * boosts confidence; otherwise the stronger signal wins.
 */
export function classifyByRules(input: RuleInput): RuleResult {
  const byName = classifyByFileName(input.fileName);
  const byContent = input.cells && input.cells.length > 0 ? classifyByContent(input.cells) : NONE;

  if (byContent.docType === 'UNKNOWN') return byName;
  if (byName.docType === 'UNKNOWN') return byContent;
  if (byName.docType === byContent.docType) {
    return {
      docType: byContent.docType,
      confidence: Math.min(0.97, Math.max(byContent.confidence, byName.confidence) + 0.1),
      reason: byContent.reason,
    };
  }
  return byContent.confidence >= byName.confidence ? byContent : byName;
}

// ── 4. Merge AI + rules (pure) ──────────────────────────────────────────────

export interface AiOpinion { docType: IntakeDocType; confidence: number; note: string }

export interface FinalClassification {
  docType: IntakeDocType;
  confidence: number;
  source: ClassificationSource;
  /** Short plain-English reason for the card. */
  note: string;
}

/**
 * Decide the final type from an AI opinion (null when AI was off / failed) and the
 * rule result:
 *   - no AI → rules;
 *   - AI unsure (UNKNOWN) → rules, if rules found anything;
 *   - AI and rules agree → AI, with the higher confidence;
 *   - they disagree → AI, unless rules are near-certain (≥0.85) and AI is weak (<0.6).
 */
export function mergeAiAndRules(ai: AiOpinion | null, rules: RuleResult): FinalClassification {
  const fromRules: FinalClassification = {
    docType: rules.docType,
    confidence: rules.confidence,
    source: 'rules',
    note: rules.reason,
  };
  if (!ai) return fromRules;
  if (ai.docType === 'UNKNOWN') return rules.docType !== 'UNKNOWN' ? fromRules : { docType: 'UNKNOWN', confidence: ai.confidence, source: 'ai', note: ai.note };
  if (ai.docType === rules.docType) {
    return { docType: ai.docType, confidence: Math.max(ai.confidence, rules.confidence), source: 'ai', note: ai.note || rules.reason };
  }
  if (rules.confidence >= 0.85 && ai.confidence < 0.6) return fromRules;
  return { docType: ai.docType, confidence: ai.confidence, source: 'ai', note: ai.note };
}
