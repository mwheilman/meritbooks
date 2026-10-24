/**
 * Document intelligence — the DETERMINISTIC classifier (works with AI off; FPB §7.3).
 *
 *   1. TEXT  — weighted phrase signatures over the PDF text layer / plain text / sheet
 *              header cells ("LEASE AGREEMENT", "Lessor", "Lessee", "Premises" → lease).
 *   2. NAME  — Smart Intake's file-name rules (lib/onboarding/intake/rules.ts) mapped to
 *              our classes, plus a few this vocabulary adds (PO, 1099, tax return).
 *   3. SHEET — Smart Intake's content sniff for spreadsheets (TB, budget, payroll …).
 * Merged: agreement boosts confidence; otherwise the stronger signal wins. Pure and
 * dependency-light (no I/O) so it is unit-tested directly.
 *
 * Also pure helpers the service uses: counterparty / date / amount hints from text, the
 * AI + rules merge, and the company (location) suggestion.
 */

import { classifyByContent, classifyByFileName, normalizeName } from '@/lib/onboarding/intake/rules';
import { classFromIntakeType, type ClassSource, type DocClass, type LocationSource } from './types';

export interface RuleInput {
  fileName: string;
  /** Readable text ('' when none). */
  text?: string | null;
  /** Spreadsheet header cells (sheets only). */
  cells?: string[] | null;
}

export interface RuleResult {
  docClass: DocClass;
  confidence: number;
  reason: string;
}

const NONE: RuleResult = { docClass: 'other', confidence: 0, reason: '' };

// ── 1. Text signatures ──────────────────────────────────────────────────────

interface Signature {
  docClass: DocClass;
  /** Strong phrases: any one is close to decisive. */
  strong: RegExp[];
  /** Supporting words: each adds a little. */
  support: RegExp[];
  label: string;
}

const SIGNATURES: Signature[] = [
  {
    docClass: 'w9',
    strong: [/request for taxpayer identification number/, /\bform w-?9\b/],
    support: [/\bcertification\b/, /\bbackup withholding\b/, /\bexempt payee\b/, /\bfatca\b/],
    label: 'Form W-9',
  },
  {
    docClass: 'coi',
    strong: [/certificate of (liability )?insurance/, /\bacord\s*25\b/],
    support: [/\bcertificate holder\b/, /\bproducer\b/, /\binsurer [a-f]\b/, /\beach occurrence\b/, /\badditional insured\b/],
    label: 'certificate of insurance',
  },
  {
    docClass: 'form_1099',
    strong: [/\bform 1099[- ]?(nec|misc|int|div|k)\b/, /\b1099-(nec|misc)\b/],
    support: [/\bnonemployee compensation\b/, /\bpayer'?s tin\b/, /\brecipient'?s tin\b/],
    label: 'Form 1099',
  },
  {
    docClass: 'tax_document',
    strong: [/\bform (1120-?s?|1065|1040|941|940|990)\b/, /\bu\.?s\.? (corporation|partnership|individual) (income )?tax return\b/, /\bnotice cp\s?\d{2,4}\b/],
    support: [/\binternal revenue service\b/, /\bdepartment of (the )?treasury\b/, /\btax year\b/, /\bdepartment of revenue\b/],
    label: 'tax return / notice',
  },
  {
    docClass: 'lease',
    strong: [/\b(commercial |office |equipment |vehicle |residential )?lease agreement\b/, /\bagreement of lease\b/, /\bsublease\b/],
    support: [/\blessor\b/, /\blessee\b/, /\blandlord\b/, /\btenant\b/, /\bpremises\b/, /\bbase rent\b/, /\bsecurity deposit\b/, /\blease term\b/, /\bcommencement date\b/, /\bsquare feet\b/],
    label: 'lease agreement',
  },
  {
    docClass: 'loan',
    strong: [/\bpromissory note\b/, /\bloan agreement\b/, /\bcredit agreement\b/, /\bline of credit\b/, /\bsecurity agreement\b/, /\bterm note\b/],
    support: [/\bborrower\b/, /\blender\b/, /\bprincipal (sum|amount)\b/, /\bmaturity date\b/, /\binterest rate\b/, /\bcovenants?\b/, /\bdefault\b/, /\bguarant(y|or)\b/],
    label: 'loan / note',
  },
  {
    docClass: 'insurance_policy',
    strong: [/\bdeclarations? page\b/, /\bpolicy declarations\b/, /\bcommon policy declarations\b/, /\bcoverage (part|form)\b/],
    support: [/\bnamed insured\b/, /\bpolicy (number|period)\b/, /\bpremium\b/, /\bdeductible\b/, /\blimits? of (insurance|liability)\b/, /\bendorsement\b/],
    label: 'insurance policy',
  },
  {
    docClass: 'payroll_register',
    strong: [/\bpayroll (register|summary|journal)\b/],
    support: [/\bgross pay\b/, /\bnet pay\b/, /\bfica\b/, /\bfederal income tax\b/, /\bcheck date\b/, /\bpay period\b/, /\bmedicare\b/],
    label: 'payroll register',
  },
  {
    docClass: 'card_statement',
    strong: [/\bminimum payment due\b/, /\bcredit card statement\b/, /\bnew balance\b.*\bpayment due date\b/],
    support: [/\bcredit (limit|line)\b/, /\bpurchases\b/, /\bcash advances?\b/, /\bfinance charge\b/, /\bstatement closing date\b/],
    label: 'card statement',
  },
  {
    docClass: 'bank_statement',
    strong: [/\b(beginning|opening) balance\b.*\b(ending|closing) balance\b/, /\baccount statement\b/, /\bstatement of account\b/],
    support: [/\bdeposits( and (other )?credits)?\b/, /\bwithdrawals\b/, /\bchecks paid\b/, /\bstatement period\b/, /\bdaily (ending )?balance\b/, /\bmember fdic\b/],
    label: 'bank statement',
  },
  {
    docClass: 'formation',
    strong: [/\barticles of (organization|incorporation)\b/, /\bcertificate of (formation|incorporation|organization)\b/, /\boperating agreement\b/, /\bcapitalization table\b/, /\bcap table\b/, /\bwe assigned you an employer identification number\b/, /\bbylaws\b/],
    support: [/\bmembers?\b/, /\bmembership interests?\b/, /\bsecretary of state\b/, /\bregistered agent\b/, /\bunits\b/, /\bshares\b/],
    label: 'formation / ownership document',
  },
  {
    docClass: 'subscription',
    strong: [/\bsubscription agreement\b/, /\border form\b/, /\bsoftware as a service\b/, /\bsaas\b/, /\bterms of service\b/],
    support: [/\bsubscription (term|fee|period)\b/, /\bauto-?renew/, /\blicen[cs]es?\b/, /\bseats?\b/, /\bper user\b/, /\bannual (plan|fee)\b/],
    label: 'subscription agreement',
  },
  {
    docClass: 'customer_contract',
    strong: [/\bstatement of work\b/, /\bmaster services agreement\b/, /\bservices agreement\b/, /\bscope of work\b/, /\bconstruction contract\b/, /\bproposal and acceptance\b/],
    support: [/\bclient\b/, /\bcustomer\b/, /\bcontractor\b/, /\bdeliverables\b/, /\bmilestones?\b/, /\bpayment schedule\b/, /\bretainage\b/, /\bchange orders?\b/],
    label: 'customer contract / SOW',
  },
  {
    docClass: 'purchase_order',
    strong: [/\bpurchase order\b/, /\bp\.?o\.? (number|no\.?|#)\b/],
    support: [/\bship to\b/, /\bqty\b/, /\bunit price\b/, /\bdeliver(y)? date\b/, /\bbuyer\b/],
    label: 'purchase order',
  },
  {
    docClass: 'budget',
    strong: [/\b(operating |annual )?budget\b/],
    support: [/\bforecast\b/, /\bjan(uary)?\b/, /\bfeb(ruary)?\b/, /\bvariance\b/, /\bfy\s?\d{2,4}\b/],
    label: 'budget',
  },
  {
    docClass: 'prepaid',
    strong: [/\bprepaid (expense|maintenance|service)\b/, /\bretainer agreement\b/, /\bservice contract\b.*\bannual\b/],
    support: [/\bpaid in advance\b/, /\bcoverage period\b/, /\bannual (maintenance|support)\b/],
    label: 'prepaid expense',
  },
  {
    docClass: 'vendor_bill',
    strong: [/\binvoice (number|no\.?|#|date)\b/, /\bremit (to|payment)\b/, /\bamount due\b/, /\bbill to\b/],
    support: [/\binvoice\b/, /\bdue date\b/, /\bsubtotal\b/, /\bterms\b/, /\bnet \d{1,2}\b/, /\bqty\b/, /\bsales tax\b/, /\bbalance due\b/],
    label: 'vendor bill / invoice',
  },
];

/** Fold text for matching: lower-case, collapse whitespace. */
export function foldText(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').slice(0, 8000);
}

/** Equipment words that turn a vendor invoice into an equipment (fixed-asset) invoice. */
const EQUIPMENT = /\b(serial (number|no\.?)|vin\b|model (number|no\.?)|equipment|machine|forklift|truck|trailer|excavator|compressor|server|laptops?|vehicle)\b/;

export function classifyByText(text: string): RuleResult {
  const t = foldText(text);
  if (t.length < 20) return NONE;
  let best: RuleResult = NONE;
  let bestScore = 0;
  for (const sig of SIGNATURES) {
    const strong = sig.strong.filter((re) => re.test(t)).length;
    const support = sig.support.filter((re) => re.test(t)).length;
    if (strong === 0 && support < 3) continue;
    const score = strong * 3 + support;
    if (score <= bestScore) continue;
    // Calibrated: one strong phrase + 2 supporting ≈ 0.8; supporting words alone cap at 0.6.
    const conf = strong > 0 ? Math.min(0.95, 0.6 + 0.1 * Math.min(support, 3) + 0.05 * (strong - 1)) : Math.min(0.6, 0.35 + 0.06 * support);
    bestScore = score;
    best = { docClass: sig.docClass, confidence: Number(conf.toFixed(3)), reason: `Text reads like a ${sig.label}` };
  }
  if (best.docClass === 'vendor_bill' && EQUIPMENT.test(t)) {
    return { docClass: 'fixed_asset_invoice', confidence: Math.min(best.confidence, 0.75), reason: 'An invoice for equipment (serial / model numbers)' };
  }
  return best;
}

// ── 2. File name ────────────────────────────────────────────────────────────

const EXTRA_NAME_RULES: Array<{ re: RegExp; docClass: DocClass; confidence: number; reason: string }> = [
  { re: /\b1099\b/, docClass: 'form_1099', confidence: 0.8, reason: 'File name says 1099' },
  { re: /\b(purchase order|po ?\d{2,})\b/, docClass: 'purchase_order', confidence: 0.7, reason: 'File name says purchase order' },
  { re: /\b(tax return|1120 ?s?|1065|941|940|cp ?\d{3,4}|irs notice|tax notice)\b/, docClass: 'tax_document', confidence: 0.7, reason: 'File name says tax return / notice' },
  { re: /\b(cap table|capitalization)\b/, docClass: 'formation', confidence: 0.75, reason: 'File name says cap table' },
  { re: /\b(credit card|amex|visa|mastercard) statement\b/, docClass: 'card_statement', confidence: 0.7, reason: 'File name says card statement' },
  { re: /\b(equipment|asset) (invoice|purchase)\b/, docClass: 'fixed_asset_invoice', confidence: 0.65, reason: 'File name says equipment invoice' },
];

export function classifyByName(fileName: string): RuleResult {
  const n = normalizeName(fileName);
  if (!n) return NONE;
  for (const r of EXTRA_NAME_RULES) if (r.re.test(n)) return { docClass: r.docClass, confidence: r.confidence, reason: r.reason };
  const intake = classifyByFileName(fileName);
  if (intake.docType === 'UNKNOWN') return NONE;
  const docClass = classFromIntakeType(intake.docType);
  if (docClass === 'other') return NONE;
  return { docClass, confidence: intake.confidence, reason: intake.reason };
}

// ── 3. Merge ────────────────────────────────────────────────────────────────

export function classifyDeterministic(input: RuleInput): RuleResult {
  const byName = classifyByName(input.fileName);
  let byContent: RuleResult = NONE;
  if (input.cells && input.cells.length > 0) {
    const sheet = classifyByContent(input.cells);
    if (sheet.docType !== 'UNKNOWN') {
      const c = classFromIntakeType(sheet.docType);
      if (c !== 'other') byContent = { docClass: c, confidence: sheet.confidence, reason: sheet.reason };
    }
  }
  if (byContent.docClass === 'other' && input.text) byContent = classifyByText(input.text);

  if (byContent.docClass === 'other') return byName;
  if (byName.docClass === 'other') return byContent;
  if (byName.docClass === byContent.docClass) {
    return {
      docClass: byContent.docClass,
      confidence: Number(Math.min(0.97, Math.max(byContent.confidence, byName.confidence) + 0.1).toFixed(3)),
      reason: byContent.reason,
    };
  }
  return byContent.confidence >= byName.confidence ? byContent : byName;
}

// ── AI + rules merge (pure) ─────────────────────────────────────────────────

export interface AiClassOpinion {
  docClass: DocClass;
  confidence: number;
  summary: string | null;
}

export interface FinalClass {
  docClass: DocClass;
  confidence: number;
  source: ClassSource;
}

/**
 * - no AI → rules;
 * - AI unsure ('other') → rules when rules found anything;
 * - agree → AI with the higher confidence;
 * - disagree → AI, unless rules are near-certain (≥ 0.85) and AI is weak (< 0.6).
 */
export function mergeClass(ai: AiClassOpinion | null, rules: RuleResult): FinalClass {
  const fromRules: FinalClass = { docClass: rules.docClass, confidence: rules.confidence, source: 'rules' };
  if (!ai) return fromRules;
  if (ai.docClass === 'other') return rules.docClass !== 'other' ? fromRules : { docClass: 'other', confidence: ai.confidence, source: 'ai' };
  if (ai.docClass === rules.docClass) return { docClass: ai.docClass, confidence: Math.max(ai.confidence, rules.confidence), source: 'ai' };
  if (rules.confidence >= 0.85 && ai.confidence < 0.6) return fromRules;
  return { docClass: ai.docClass, confidence: ai.confidence, source: 'ai' };
}

// ── Hints from text (pure) ──────────────────────────────────────────────────

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** First ISO date from a date-ish token ("March 1, 2025", "03/01/2025", "2025-03-01"). */
export function parseLooseDate(s: string): string | null {
  const iso = /\b(20\d{2}|19\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(s);
  if (iso) return fmt(+iso[1], +iso[2], +iso[3]);
  const us = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(s);
  if (us) {
    const y = us[3].length === 2 ? 2000 + +us[3] : +us[3];
    return fmt(y, +us[1], +us[2]);
  }
  const long = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(s);
  if (long) return fmt(+long[3], MONTHS[long[1].toLowerCase()], +long[2]);
  return null;
}

function fmt(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Labelled dates found in text: effective / commencement / expiration / maturity / due. */
export function keyDatesFromText(text: string): Record<string, string> {
  const t = text.replace(/\s+/g, ' ');
  const out: Record<string, string> = {};
  const probes: Array<[string, RegExp]> = [
    ['effective_date', /\b(effective|commencement|start|dated as of|as of)\b(?: date)?[:\s]{0,4}(.{0,40})/i],
    ['expiration_date', /\b(expiration|expires|expiry|termination|end)\b(?: date)?[:\s]{0,4}(.{0,40})/i],
    ['maturity_date', /\bmaturity\b(?: date)?[:\s]{0,4}(.{0,40})/i],
    ['due_date', /\b(due date|payment due)\b[:\s]{0,4}(.{0,40})/i],
  ];
  for (const [key, re] of probes) {
    const m = re.exec(t);
    const tail = m ? m[m.length - 1] : '';
    const d = tail ? parseLooseDate(tail) : null;
    if (d) out[key] = d;
  }
  return out;
}

/** "Lessor: Acme Properties LLC" / "Lender: First Bank" / "Bill from …" → the other party. */
export function counterpartyFromText(text: string, docClass: DocClass): string | null {
  const t = text.replace(/[ \t]+/g, ' ');
  const NAME = "([A-Z][A-Za-z0-9&.,' -]{2,80}?)";
  const END = '(?:\\s*[,(\"]|\\s+\\(|\\n|$)';
  const lab = (words: string): RegExp => new RegExp(`\\b(?:${words})(?![A-Za-z])[:\\s,]*(?:is\\s+)?${NAME}${END}`);
  const labels: Partial<Record<DocClass, RegExp>> = {
    lease: lab('[Ll]essor|LESSOR|[Ll]andlord|LANDLORD'),
    loan: lab('[Ll]ender|LENDER|[Hh]older|HOLDER'),
    insurance_policy: lab('[Ii]nsurer|INSURER|[Cc]arrier|CARRIER|[Ii]nsurance [Cc]ompany'),
    coi: lab('[Ii]nsured|INSURED'),
    w9: lab('[Nn]ame \\(as shown on your income tax return\\)'),
  };
  // "between Acme Properties LLC ("Lessor") and …" — the name before the role.
  const before: Partial<Record<DocClass, string>> = { lease: 'Lessor|Landlord', loan: 'Lender|Holder' };
  const tries: RegExp[] = [];
  if (labels[docClass]) tries.push(labels[docClass] as RegExp);
  if (before[docClass]) tries.push(new RegExp(`(?:between|and|by|pay|to|with|from)\\s+${NAME}\\s*\\(\\s*["\u201c]?(?:${before[docClass]})["\u201d]?\\s*\\)`, 'm'));
  for (const re of tries) {
    const m = re.exec(t);
    // The leftmost "between" may swallow the first party: keep the name nearest the role.
    const raw = m?.[m.length - 1] ?? '';
    const v = (raw.split(/\s+(?:and|between|by|pay|to|with|from)\s+/).pop() ?? '').trim().replace(/[ ,.]+$/, '');
    if (v.length >= 3) return v.slice(0, 120);
  }
  return null;
}

/** Largest "$12,345.67" amount in text, in cents (null when none). */
export function largestAmountCents(text: string): number | null {
  let best = 0;
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g)) {
    const cents = Number(m[1].replace(/,/g, '')) * 100 + Number(m[2] ?? 0);
    if (Number.isSafeInteger(cents) && cents > best && cents < 1e13) best = cents;
  }
  return best > 0 ? best : null;
}

// ── Company suggestion (pure) ───────────────────────────────────────────────

export interface CompanyOption {
  id: string;
  name: string;
  short_code?: string | null;
}

export interface CompanySuggestion {
  locationId: string | null;
  source: LocationSource | null;
}

function foldName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(llc|l\.l\.c\.|inc|incorporated|corp|corporation|co|company|ltd|lp|llp|pllc|the)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Which company does this document belong to?
 *   1. the company it was uploaded under (onboarding / an `entity_type='location'` row);
 *   2. the only company in the org;
 *   3. a company named in the AI answer, then one named in the text (longest name wins,
 *      so "Merit SPE 2" beats "Merit");
 *   4. unknown (a person picks it when accepting).
 */
export function suggestCompany(
  companies: readonly CompanyOption[],
  hints: { uploadLocationId?: string | null; aiCompanyName?: string | null; text?: string | null },
): CompanySuggestion {
  if (hints.uploadLocationId && companies.some((c) => c.id === hints.uploadLocationId)) {
    return { locationId: hints.uploadLocationId, source: 'upload' };
  }
  if (companies.length === 1) return { locationId: companies[0].id, source: 'single_company' };
  const named = (hay: string): CompanyOption | null => {
    const h = ` ${foldName(hay)} `;
    let best: CompanyOption | null = null;
    let bestLen = 0;
    for (const c of companies) {
      const n = foldName(c.name);
      if (n.length < 3) continue;
      if (h.includes(` ${n} `) && n.length > bestLen) {
        best = c;
        bestLen = n.length;
      }
    }
    return best;
  };
  if (hints.aiCompanyName) {
    const c = named(hints.aiCompanyName);
    if (c) return { locationId: c.id, source: 'ai' };
  }
  if (hints.text) {
    const c = named(hints.text.slice(0, 8000));
    if (c) return { locationId: c.id, source: 'rules' };
  }
  return { locationId: null, source: null };
}
