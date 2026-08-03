/**
 * Deterministic query parser for the SEARCH lane.
 *
 * Pure, dependency-free, and unit-tested. Extracts amounts (with over/under/
 * between ranges), dates / date-ranges, explicit type hints, reference-number
 * tokens, and free-text terms from a plain-English query. This is the
 * model-free core: every DB filter downstream is built from this structure, so
 * no SQL is ever authored by a model.
 */

import type {
  AmountConstraint,
  DateRange,
  ParsedQuery,
  SearchType,
} from './types';

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

/** Words that map to an explicit object-type filter. */
const TYPE_KEYWORDS: Array<[RegExp, SearchType]> = [
  [/\b(journal|journals|je|jes|journal[- ]?entr(y|ies)|entry|entries)\b/, 'journal_entry'],
  [/\b(bank|transaction|transactions|charge|charges|deposit|deposits|feed)\b/, 'bank_transaction'],
  [/\b(invoice|invoices|ar|receivable|receivables)\b/, 'invoice'],
  [/\b(bill|bills|ap|payable|payables)\b/, 'bill'],
  [/\b(vendor|vendors|supplier|suppliers|payee|payees)\b/, 'vendor'],
  [/\b(customer|customers|client|clients)\b/, 'customer'],
  [/\b(account|accounts|gl account|ledger account|coa)\b/, 'account'],
];

/** Common words removed from free-text terms (they carry no retrieval signal). */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'for', 'of', 'to', 'in', 'on', 'at', 'by', 'is', 'are',
  'was', 'were', 'be', 'show', 'me', 'find', 'search', 'all', 'my', 'with',
  'from', 'and', 'or', 'that', 'this', 'these', 'those', 'what', 'which',
  'who', 'get', 'give', 'list', 'any', 'some', 'about', 'related', 'please',
  'where', 'when', 'how', 'do', 'did', 'does', 'i', 'we', 'us', 'our',
  'between', 'over', 'under', 'above', 'below', 'more', 'less', 'than',
  'greater', 'least', 'most', 'up', 'dollars', 'dollar', 'usd', 'amount',
]);

const RELATIVE_DATE_WORDS = new Set([
  'today', 'yesterday', 'ytd', 'mtd', 'qtd',
]);

/**
 * Connector words that only ever appear as part of a relative-date phrase
 * (e.g. "last month", "this year", "q3 2026"). They carry no retrieval signal on
 * their own, and the date itself is captured by `parseDates`, so they must not
 * leak into free-text terms.
 */
const DATE_PHRASE_WORDS = new Set([
  'last', 'next', 'month', 'months', 'year', 'years',
  'quarter', 'quarters', 'week', 'weeks',
  'q1', 'q2', 'q3', 'q4',
]);

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoDay(year: number, month0: number, day: number): string {
  return `${year}-${pad(month0 + 1)}-${pad(day)}`;
}

function lastDayOfMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** Parse a dollar-string like "1,500.99" / "1500" / "1.5k" into cents. */
export function dollarStringToCents(numStr: string, suffix?: string): number | null {
  const cleaned = numStr.replace(/,/g, '');
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  let dollars = value;
  if (suffix === 'k') dollars = value * 1_000;
  else if (suffix === 'm') dollars = value * 1_000_000;
  return Math.round(dollars * 100);
}

const AMOUNT_TOKEN = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s*([km])?';

/** Extract amount intent (exact values + optional min/max range) in cents. */
export function parseAmounts(raw: string): AmountConstraint {
  const lower = raw.toLowerCase();
  const exact: number[] = [];
  let min: number | null = null;
  let max: number | null = null;

  const consumed: Array<[number, number]> = [];
  const markConsumed = (m: RegExpExecArray) => consumed.push([m.index, m.index + m[0].length]);
  const overlaps = (idx: number) => consumed.some(([s, e]) => idx >= s && idx < e);

  // "between X and Y"
  const between = new RegExp(`between\\s+\\$?\\s*${AMOUNT_TOKEN}\\s+and\\s+\\$?\\s*${AMOUNT_TOKEN}`, 'i').exec(lower);
  if (between) {
    const a = dollarStringToCents(between[1], between[2]);
    const b = dollarStringToCents(between[3], between[4]);
    if (a != null && b != null) {
      min = Math.min(a, b);
      max = Math.max(a, b);
    }
    markConsumed(between);
  }

  // "over / above / more than / at least / >= X"
  const over = new RegExp(`(?:over|above|more than|greater than|at least|>=?)\\s+\\$?\\s*${AMOUNT_TOKEN}`, 'i').exec(lower);
  if (over && !overlaps(over.index)) {
    const a = dollarStringToCents(over[1], over[2]);
    if (a != null) min = min == null ? a : Math.max(min, a);
    markConsumed(over);
  }

  // "under / below / less than / at most / up to / <= X"
  const under = new RegExp(`(?:under|below|less than|at most|up to|<=?)\\s+\\$?\\s*${AMOUNT_TOKEN}`, 'i').exec(lower);
  if (under && !overlaps(under.index)) {
    const a = dollarStringToCents(under[1], under[2]);
    if (a != null) max = max == null ? a : Math.min(max, a);
    markConsumed(under);
  }

  // Explicit money tokens ($X, X.dd, X,ddd, Xk/Xm) not already consumed by a range.
  const moneyRe = new RegExp(`\\$\\s*${AMOUNT_TOKEN}|\\b${AMOUNT_TOKEN}\\b`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = moneyRe.exec(lower)) !== null) {
    if (overlaps(m.index)) continue;
    const numStr = m[1] ?? m[3];
    const suffix = m[2] ?? m[4];
    if (!numStr) continue;
    const hasDollar = m[0].trim().startsWith('$');
    const hasDecimal = numStr.includes('.');
    const hasThousands = numStr.includes(',');
    const hasSuffix = Boolean(suffix);
    // Only treat as an *amount* when there is a money signal. Bare integers are
    // handled as number tokens (see parseNumberTokens) so IDs don't become money.
    if (!(hasDollar || hasDecimal || hasThousands || hasSuffix)) continue;
    const cents = dollarStringToCents(numStr, suffix);
    if (cents != null && !exact.includes(cents)) exact.push(cents);
  }

  return { exact, min, max };
}

/** Reference-number-like tokens: alnum with a digit, plus bare integers. */
export function parseNumberTokens(raw: string): string[] {
  const tokens: string[] = [];
  const re = /\b([a-z]{1,6}[-#]?\d[\w-]*|\d{2,})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const tok = m[1];
    // Skip 4-digit years — those are dates, not reference numbers.
    if (/^(19|20)\d{2}$/.test(tok)) continue;
    if (!tokens.includes(tok)) tokens.push(tok);
  }
  return tokens;
}

/** Extract a single date window, or null. `now` is injectable for tests. */
export function parseDates(raw: string, now: Date = new Date()): DateRange | null {
  const lower = raw.toLowerCase();
  const curYear = now.getUTCFullYear();
  const curMonth0 = now.getUTCMonth();

  // ISO yyyy-mm-dd
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(lower);
  if (iso) {
    const d = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return { from: d, to: d };
  }

  // US m/d/yyyy or m/d/yy
  const us = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(lower);
  if (us) {
    let year = Number.parseInt(us[3], 10);
    if (year < 100) year += 2000;
    const month0 = Math.min(11, Math.max(0, Number.parseInt(us[1], 10) - 1));
    const day = Math.min(31, Math.max(1, Number.parseInt(us[2], 10)));
    const d = isoDay(year, month0, day);
    return { from: d, to: d };
  }

  // Relative windows.
  if (/\blast month\b/.test(lower)) {
    const y = curMonth0 === 0 ? curYear - 1 : curYear;
    const m0 = curMonth0 === 0 ? 11 : curMonth0 - 1;
    return { from: isoDay(y, m0, 1), to: isoDay(y, m0, lastDayOfMonth(y, m0)) };
  }
  if (/\bthis month\b/.test(lower)) {
    return { from: isoDay(curYear, curMonth0, 1), to: isoDay(curYear, curMonth0, lastDayOfMonth(curYear, curMonth0)) };
  }
  if (/\blast year\b/.test(lower)) {
    return { from: isoDay(curYear - 1, 0, 1), to: isoDay(curYear - 1, 11, 31) };
  }
  if (/\bthis year\b/.test(lower)) {
    return { from: isoDay(curYear, 0, 1), to: isoDay(curYear, 11, 31) };
  }

  // Quarter: q1..q4 with optional year.
  const q = /\bq([1-4])(?:\s+(\d{4}))?\b/.exec(lower);
  if (q) {
    const quarter = Number.parseInt(q[1], 10);
    const year = q[2] ? Number.parseInt(q[2], 10) : curYear;
    const startM0 = (quarter - 1) * 3;
    const endM0 = startM0 + 2;
    return { from: isoDay(year, startM0, 1), to: isoDay(year, endM0, lastDayOfMonth(year, endM0)) };
  }

  // Month name, with optional year.
  const monthRe = /\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\b(?:\s+(\d{4}))?/;
  const mn = monthRe.exec(lower);
  if (mn) {
    const month0 = MONTHS[mn[1]];
    const year = mn[2] ? Number.parseInt(mn[2], 10) : curYear;
    return { from: isoDay(year, month0, 1), to: isoDay(year, month0, lastDayOfMonth(year, month0)) };
  }

  // Year alone.
  const yr = /\b(19|20)\d{2}\b/.exec(lower);
  if (yr) {
    const year = Number.parseInt(yr[0], 10);
    return { from: isoDay(year, 0, 1), to: isoDay(year, 11, 31) };
  }

  return null;
}

/** Explicit object types named in the query; null when none is named. */
export function parseTypes(raw: string): SearchType[] | null {
  const lower = raw.toLowerCase();
  const found = new Set<SearchType>();
  for (const [re, type] of TYPE_KEYWORDS) {
    if (re.test(lower)) found.add(type);
  }
  return found.size > 0 ? Array.from(found) : null;
}

/** Free-text terms after removing amounts, dates, type words, and stopwords. */
export function parseTerms(raw: string): string[] {
  const lower = raw.toLowerCase();
  const rawTokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const terms: string[] = [];
  for (const tok of rawTokens) {
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    if (RELATIVE_DATE_WORDS.has(tok)) continue;
    if (DATE_PHRASE_WORDS.has(tok)) continue;
    if (tok in MONTHS) continue;
    if (/^\d+$/.test(tok)) continue; // pure numbers → handled as amounts/number tokens
    if (/^\d{4}$/.test(tok)) continue;
    // Drop type keywords so "invoices from acme" searches for "acme".
    if (TYPE_KEYWORDS.some(([re]) => re.test(tok))) continue;
    if (!terms.includes(tok)) terms.push(tok);
  }
  return terms;
}

/** Full deterministic parse. */
export function parseQuery(raw: string, now: Date = new Date()): ParsedQuery {
  const trimmed = raw.trim();
  return {
    raw: trimmed,
    terms: parseTerms(trimmed),
    numberTokens: parseNumberTokens(trimmed),
    amounts: parseAmounts(trimmed),
    dateRange: parseDates(trimmed, now),
    types: parseTypes(trimmed),
  };
}

/** True when the deterministic parse produced no usable constraint at all. */
export function hasNoConstraint(parsed: ParsedQuery): boolean {
  return (
    parsed.terms.length === 0 &&
    parsed.numberTokens.length === 0 &&
    parsed.amounts.exact.length === 0 &&
    parsed.amounts.min == null &&
    parsed.amounts.max == null &&
    parsed.dateRange == null
  );
}

/** True when the parse is thin enough that AI intent extraction may help. */
export function isAmbiguous(parsed: ParsedQuery): boolean {
  const noStructure =
    parsed.amounts.exact.length === 0 &&
    parsed.amounts.min == null &&
    parsed.amounts.max == null &&
    parsed.dateRange == null &&
    parsed.types == null;
  // Ambiguous = a natural-language question with no structured anchor.
  return noStructure && parsed.raw.split(/\s+/).length >= 4;
}
