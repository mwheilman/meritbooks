/**
 * Match a dropped trial-balance file to a company — pure, deterministic (no AI).
 *
 * Works with AI off (FPB principle 10). Evidence, strongest first:
 *   1. the company name printed in the file's title rows (QuickBooks puts it on row 1),
 *   2. the company name inside the file name ("Heritage Interiors TB 9-30.csv"),
 *   3. the company's short code as a token in the file name ("HI_TB.xlsx"),
 *   4. fuzzy similarity (token overlap + character bigrams) for typos/abbreviations.
 *
 * Returns the best company with a 0..1 confidence and a plain-English reason, plus
 * the runners-up so the UI can offer them. Below MIN_CONFIDENCE → no match.
 */

import { nameWords } from '../short-code';

export interface CompanyRef { id: string; name: string; shortCode: string }

export interface CompanyMatch {
  companyId: string | null;
  confidence: number;
  reason: string;
  alternatives: Array<{ companyId: string; confidence: number }>;
}

export const MIN_CONFIDENCE = 0.45;

const LEGAL = new Set([
  'the', 'and', 'of', 'llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'ltd', 'limited', 'lp', 'llp', 'lllp', 'pllc', 'pc', 'plc', 'pa',
]);
const FILE_NOISE = new Set([
  'trial', 'balance', 'balances', 'tb', 'as', 'at', 'of', 'report', 'export', 'final', 'qbo', 'qb',
  'quickbooks', 'xero', 'sage', 'accrual', 'cash', 'basis', 'adjusted', 'unadjusted', 'summary',
  'detail', 'opening', 'ending', 'copy', 'v1', 'v2', 'v3', 'draft', 'csv', 'xlsx', 'pdf', 'fy',
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june',
  'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october', 'nov', 'november',
  'dec', 'december',
]);

function tokens(s: string, extraNoise?: Set<string>): string[] {
  return nameWords(s)
    .map((w) => w.toLowerCase())
    .filter((w) => !LEGAL.has(w) && !(extraNoise?.has(w)) && !/^\d+$/.test(w));
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[a-z0-9]{1,5}$/i, '');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/\s+/g, ' ');
  for (let i = 0; i < t.length - 1; i++) {
    const b = t.slice(i, i + 2);
    m.set(b, (m.get(b) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice coefficient over character bigrams, 0..1. */
export function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (const v of A.values()) sizeA += v;
  for (const v of B.values()) sizeB += v;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return sizeA + sizeB === 0 ? 0 : (2 * inter) / (sizeA + sizeB);
}

/** True when `needle` appears as a contiguous run inside `hay`. */
function containsPhrase(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function scoreCompany(
  company: CompanyRef,
  fileTokens: string[],
  rawFileTokens: string[],
  titleTokenLines: string[][],
): { score: number; reason: string } {
  const nameT = tokens(company.name);
  const code = company.shortCode.toLowerCase();
  let best = { score: 0, reason: '' };
  const consider = (score: number, reason: string) => { if (score > best.score) best = { score, reason }; };

  if (nameT.length > 0) {
    for (const t of titleTokenLines) {
      if (t.join(' ') === nameT.join(' ')) consider(0.99, 'Company name is the file’s title');
      else if (containsPhrase(t, nameT)) consider(0.95, 'Company name appears in the file’s title rows');
      else {
        const sim = diceSimilarity(t.join(' '), nameT.join(' '));
        consider(sim * 0.85, sim >= 0.7 ? 'Title rows closely resemble the company name' : 'Partial title match');
      }
    }
    if (containsPhrase(fileTokens, nameT)) consider(0.92, 'Company name is in the file name');
    const overlap = nameT.filter((w) => fileTokens.includes(w)).length / nameT.length;
    if (overlap > 0) consider(overlap * 0.8, overlap === 1 ? 'All name words are in the file name' : 'Some name words are in the file name');
    const sim = diceSimilarity(fileTokens.join(' '), nameT.join(' '));
    consider(sim * 0.8, 'File name resembles the company name');
  }
  if (code.length >= 2 && rawFileTokens.includes(code)) consider(0.85, `Short code ${company.shortCode} is in the file name`);
  return best;
}

export function matchTbToCompany(
  input: { fileName: string; titleLines: string[] },
  companies: CompanyRef[],
): CompanyMatch {
  const base = stripExtension(input.fileName ?? '');
  const fileTokens = tokens(base, FILE_NOISE);
  const rawFileTokens = nameWords(base).map((w) => w.toLowerCase());
  const titleTokenLines = (input.titleLines ?? [])
    .slice(0, 6)
    .map((l) => tokens(l, FILE_NOISE))
    .filter((t) => t.length > 0);

  const scored = companies
    .map((c) => ({ c, ...scoreCompany(c, fileTokens, rawFileTokens, titleTokenLines) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < MIN_CONFIDENCE) {
    return {
      companyId: null,
      confidence: top ? round2(top.score) : 0,
      reason: 'No company name or short code found in the file name or title rows',
      alternatives: scored.slice(0, 3).filter((s) => s.score > 0.2).map((s) => ({ companyId: s.c.id, confidence: round2(s.score) })),
    };
  }

  let confidence = top.score;
  let reason = top.reason;
  const second = scored[1];
  if (second && second.score >= top.score - 0.05 && top.score < 0.95) {
    confidence *= 0.8;
    reason = `${reason} — but “${second.c.name}” is nearly as close`;
  }
  return {
    companyId: top.c.id,
    confidence: round2(confidence),
    reason,
    alternatives: scored.slice(1, 4).filter((s) => s.score > 0.2).map((s) => ({ companyId: s.c.id, confidence: round2(s.score) })),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The company name a TB file seems to be for (first title line), when it has one. */
export function suggestedCompanyName(titleLines: string[]): string | null {
  for (const l of titleLines.slice(0, 3)) {
    const t = l.trim();
    if (!t) continue;
    if (/trial\s+balance/i.test(t) || /^as\s+of\b/i.test(t) || /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(t)) continue;
    if (t.length > 200) continue;
    return t;
  }
  return null;
}
