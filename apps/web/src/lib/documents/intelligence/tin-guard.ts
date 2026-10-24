/**
 * The taxpayer-ID screen (security review H4) — decides, BEFORE anything is sent to an AI
 * model, whether a document may carry a TIN (W-9, W-8BEN/-E, 1099, W-2, W-4, SS-4, the
 * IRS EIN letter CP-575, 941 / 940, income-tax returns, IRS notices).
 *
 *   tin_form  the text layer, the file name, the deterministic rules or the person's chosen
 *             type says it is a TIN-bearing form → typed natively (rules), NEVER sent to
 *             AI — not the classifier, not a module extractor.
 *   clear     a TIN-bearing form was ruled out by safe means: a readable text layer with
 *             no form signature, a person chose a non-tax type, or the file name confidently
 *             names a non-tax document → AI may read it (text is still redacted).
 *   unknown   nothing safe to go on (a photo / scan with no text layer and a meaningless
 *             name) → MANUAL REVIEW: a person picks the type; AI never sees the bytes.
 *
 * Pure (no I/O); unit-tested directly.
 */

import { classifyByName } from './rules';
import { ROUTE_MIN_CONFIDENCE, W9_NO_AI_CONFIDENCE, type DocClass } from './types';

export type TinForm = 'W-9' | 'W-8' | '1099' | 'W-2' | 'W-4' | 'SS-4' | 'CP-575' | '941/940' | 'tax return' | 'IRS notice';

/** Classes that are (or routinely carry) a taxpayer ID: never sent to AI. */
export const TIN_CLASSES: ReadonlySet<DocClass> = new Set<DocClass>(['w9', 'form_1099', 'tax_document']);

/** At least this much readable text counts as "a text layer" (an Info Title alone does not). */
export const MIN_SCREEN_TEXT = 40;

interface FormSig {
  form: TinForm;
  docClass: DocClass;
  /** The form's own title: one is decisive. */
  title: RegExp[];
  /** The form's name / number: decisive together with one supporting phrase. */
  name: RegExp[];
  support: RegExp[];
}

const IRS = [/\binternal revenue service\b/, /\bdepartment of the treasury\b/];
const EIN = /\bemployer identification number\b/;

const FORMS: FormSig[] = [
  {
    form: 'W-9',
    docClass: 'w9',
    title: [/\brequest for taxpayer identification number\b/],
    name: [/\bform w-?9\b/],
    // Form-specific phrases only: a lease or MSA that says "deliver a Form W-9" is not one.
    support: [/\bbackup withholding\b/, /\bexempt payee\b/, /\bfatca\b/, /\bprint or type\b/, /\bpart ii certification\b/, /\bunder penalties of perjury\b/],
  },
  {
    form: 'W-8',
    docClass: 'tax_document',
    title: [/\bcertificate of (foreign )?status of beneficial owner\b/, /\bcertificate of foreign person'?s claim\b/],
    name: [/\bform w-?8 ?(ben(-e)?|eci|exp|imy)\b/],
    support: [/\bbeneficial owner\b/, /\bforeign tax identifying number\b/, /\btaxpayer identification number\b/, /\bchapter [34] status\b/],
  },
  {
    form: '1099',
    docClass: 'form_1099',
    title: [/\b(payer|recipient)'?s (tin|taxpayer identification number|federal identification number)\b/],
    name: [/\bform 1099\b/, /\b1099-(nec|misc|int|div|k|r|b|s|g|oid|patr|q|sa|ltc|c|a)\b/],
    support: [/\bnonemployee compensation\b/, /\bcopy [abc12] for\b/, /\bfor recipient\b/, /\bfederal income tax withheld\b/, ...IRS],
  },
  {
    form: 'W-2',
    docClass: 'tax_document',
    title: [/\bwage and tax statement\b/],
    name: [/\bform w-?2\b/],
    support: [EIN, /\bemployee'?s social security number\b/, /\bsocial security wages\b/, /\bmedicare wages\b/, /\bfederal income tax withheld\b/],
  },
  {
    form: 'W-4',
    docClass: 'tax_document',
    title: [/\bemployee'?s withholding (allowance )?certificate\b/],
    name: [/\bform w-?4\b/],
    support: [/\bsocial security number\b/, /\bfiling status\b/, /\bmultiple jobs\b/, /\bclaim dependents?\b/],
  },
  {
    form: 'SS-4',
    docClass: 'formation',
    title: [/\bapplication for employer identification number\b/],
    name: [/\bform ss-?4\b/],
    support: [/\bresponsible party\b/, /\btype of entity\b/, /\bssn, itin,? or ein\b/, ...IRS],
  },
  {
    form: 'CP-575',
    docClass: 'formation',
    title: [/\bwe assigned you an employer identification number\b/, /\bnotice cp ?575\b/],
    name: [/\bcp ?575\b/],
    support: [EIN, ...IRS],
  },
  {
    form: '941/940',
    docClass: 'tax_document',
    title: [/\bemployer'?s quarterly federal tax return\b/, /\bemployer'?s annual federal unemployment \(?futa\)? tax return\b/],
    name: [/\bform 94[01]\b/],
    support: [EIN, /\bnumber of employees\b/, ...IRS],
  },
  {
    form: 'tax return',
    docClass: 'tax_document',
    title: [/\bu\.?s\.? (s )?(corporation|partnership|individual) (income )?tax return\b/, /\bu\.?s\.? return of partnership income\b/, /\bu\.?s\.? income tax return for an s corporation\b/],
    name: [/\bform (1120-?s?|1065|1040)\b/],
    support: [EIN, /\btax year\b/, /\bsocial security number\b/, ...IRS],
  },
  {
    form: 'IRS notice',
    docClass: 'tax_document',
    title: [],
    name: [/\bnotice cp ?\d{2,4}\b/, /\bletter \d{3,4}c\b/],
    support: [EIN, /\bsocial security number\b/, /\btaxpayer identification number\b/, ...IRS],
  },
];

function fold(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
}

/** A TIN-bearing form named by the document's own text (title, or form number + one support phrase). */
export function tinFormFromText(text: string | null | undefined): { form: TinForm; docClass: DocClass } | null {
  if (!text) return null;
  const t = fold(text);
  if (t.length < 8) return null;
  for (const f of FORMS) {
    if (f.title.some((re) => re.test(t))) return { form: f.form, docClass: f.docClass };
    if (f.name.some((re) => re.test(t)) && f.support.some((re) => re.test(t))) return { form: f.form, docClass: f.docClass };
  }
  return null;
}

// File names: separators vary ("Bolt_W9.pdf", "w-9 2024.pdf", "BoltW9.pdf").
const NAME_FORMS: Array<{ re: RegExp; form: TinForm; docClass: DocClass }> = [
  { re: /(?<![0-9])w[-_ ]?9(?![0-9])/, form: 'W-9', docClass: 'w9' },
  { re: /(?<![0-9])w[-_ ]?8[-_ ]?(ben|eci|exp|imy)/, form: 'W-8', docClass: 'tax_document' },
  { re: /(?<![0-9])1099(?![0-9])/, form: '1099', docClass: 'form_1099' },
  { re: /(?<![a-z0-9])w[-_ ]?2(?![0-9])/, form: 'W-2', docClass: 'tax_document' },
  { re: /(?<![a-z0-9])w[-_ ]?4(?![0-9])/, form: 'W-4', docClass: 'tax_document' },
  { re: /(?<![a-z0-9])ss[-_ ]?4(?![0-9])/, form: 'SS-4', docClass: 'formation' },
  { re: /(?<![a-z0-9])cp[-_ ]?575(?![0-9])/, form: 'CP-575', docClass: 'formation' },
  { re: /(?<![a-z0-9])ein[-_ ]?(letter|confirmation|assignment|notice|verification)/, form: 'CP-575', docClass: 'formation' },
  { re: /(?<![a-z0-9])(form|irs)[-_ ]?94[01](?![0-9])|(?<![0-9])94[01][-_ ]?(q[1-4]|quarter|return)/, form: '941/940', docClass: 'tax_document' },
  { re: /(?<![a-z0-9])(form[-_ ]?(1120s?|1065|1040)|tax[-_ ]?return)(?![0-9])/, form: 'tax return', docClass: 'tax_document' },
  { re: /(?<![a-z0-9])(ssn|itin|social[-_ ]?security|tax[-_ ]?id|taxpayer[-_ ]?id)(?![a-z])/, form: 'W-9', docClass: 'tax_document' },
];

/** A TIN-bearing form named by the file name. */
export function tinFormFromName(fileName: string | null | undefined): { form: TinForm; docClass: DocClass } | null {
  const n = (fileName ?? '').toLowerCase();
  if (!n) return null;
  for (const r of NAME_FORMS) if (r.re.test(n)) return { form: r.form, docClass: r.docClass };
  return null;
}

export interface ScreenInput {
  fileName: string;
  /** Everything readable from the file for the screen (raw: no readability filter). */
  screenText: string;
  /** The classifier's readable text sample ('' for a photo / scan). */
  readableText: string;
  /** The deterministic class for the file (rules). */
  rulesClass: DocClass;
  rulesConfidence: number;
  /** The type a person chose (null when no one has). */
  userClass: DocClass | null;
}

export type TinScreen =
  | { verdict: 'tin_form'; form: TinForm | null; docClass: DocClass; via: 'text' | 'name' | 'rules' | 'user' }
  | { verdict: 'clear'; via: 'text' | 'name' | 'user' }
  | { verdict: 'unknown' };

export function screenForTin(input: ScreenInput): TinScreen {
  const byText = tinFormFromText(input.screenText);
  if (byText) return { verdict: 'tin_form', form: byText.form, docClass: byText.docClass, via: 'text' };
  if (input.userClass && TIN_CLASSES.has(input.userClass)) return { verdict: 'tin_form', form: null, docClass: input.userClass, via: 'user' };
  const byName = tinFormFromName(input.fileName);
  if (byName) return { verdict: 'tin_form', form: byName.form, docClass: byName.docClass, via: 'name' };
  if (TIN_CLASSES.has(input.rulesClass) && input.rulesConfidence >= W9_NO_AI_CONFIDENCE) {
    return { verdict: 'tin_form', form: null, docClass: input.rulesClass, via: 'rules' };
  }
  if (input.userClass) return { verdict: 'clear', via: 'user' };
  if (input.readableText.trim().length >= MIN_SCREEN_TEXT) return { verdict: 'clear', via: 'text' };
  const named = classifyByName(input.fileName);
  if (named.docClass !== 'other' && !TIN_CLASSES.has(named.docClass) && named.confidence >= ROUTE_MIN_CONFIDENCE) return { verdict: 'clear', via: 'name' };
  return { verdict: 'unknown' };
}

/** Why a document waits for a person instead of the AI read (shown in the Documents center). */
export const TIN_REVIEW_REASON =
  'Scanned or photo file with no readable text — to protect taxpayer IDs it is not sent to AI until someone confirms it isn’t a tax form (W-9, 1099, W-2 …). Pick its type.';

/**
 * The class a TIN-screened document is typed as (no AI): the person's choice; else a
 * near-certain non-tax class from the rules (a lease whose file name says "W9" stays a
 * lease — but is still never sent to AI); else the form the screen recognised.
 */
export function tinScreenedClass(
  screen: Extract<TinScreen, { verdict: 'tin_form' }>,
  rules: { docClass: DocClass; confidence: number },
): { docClass: DocClass; confidence: number } {
  if (screen.via === 'user') return { docClass: screen.docClass, confidence: 1 };
  if (rules.docClass !== 'other' && !TIN_CLASSES.has(rules.docClass) && rules.confidence >= 0.85 && rules.docClass !== screen.docClass) {
    return { docClass: rules.docClass, confidence: rules.confidence };
  }
  const base = screen.via === 'text' ? 0.9 : 0.75;
  return { docClass: screen.docClass, confidence: rules.docClass === screen.docClass ? Math.max(base, rules.confidence) : base };
}

export function tinFormReason(form: TinForm | null): string {
  return `${form ? `Looks like a ${form}` : 'A tax form'} — it carries a taxpayer ID, so it was typed without AI and is never sent to AI.`;
}

export function tinExtractBlocked(moduleLabel: string): string {
  return `This document carries a taxpayer ID, so it is not read by AI — enter the details in ${moduleLabel}.`;
}
