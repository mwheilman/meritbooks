/**
 * Figure formatting for the Merit Suite (Style Guide §8 data-craft rules).
 *
 * - Money is ALWAYS integer cents in and out. No floating-point money math:
 *   every split into dollars/cents uses integer remainder arithmetic.
 * - Negatives use parentheses — (4,454.42) — never a minus sign or red.
 * - Grouping is done by hand (not Intl) so output is identical on the server,
 *   in every browser, and in tests.
 * - Currency and units live in the column header, not in the cell, so no "$"
 *   by default.
 */

const MINUS = '−'; // typographic minus for deltas ("−2.3 pts")

export class CentsError extends TypeError {
  constructor(value: unknown) {
    super(`Money must be integer cents; got ${String(value)}`);
    this.name = 'CentsError';
  }
}

/** Throws unless `n` is a safe integer (cents). */
export function assertCents(n: number): number {
  if (!Number.isSafeInteger(n)) throw new CentsError(n);
  return n;
}

/** Sum integer cents, asserting every addend is an integer. */
export function sumCents(values: ReadonlyArray<number>): number {
  let total = 0;
  for (const v of values) total += assertCents(v);
  return assertCents(total);
}

/** "1234567" → "1,234,567" (digits only, no sign). */
export function groupDigits(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && fromEnd % 3 === 1) out += ',';
  }
  return out;
}

/** Split |cents| into whole units and the remainder, by integer arithmetic. */
function splitCents(cents: number): { whole: number; rem: number } {
  const abs = Math.abs(cents);
  const rem = abs % 100;
  return { whole: (abs - rem) / 100, rem };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export type SignStyle = 'parens' | 'minus' | 'delta';

export interface MoneyOptions {
  /** 2 (default) shows cents; 0 rounds half-up to whole units. */
  decimals?: 0 | 2;
  /**
   * parens (default): (4,454.42) · minus: −4,454.42 ·
   * delta: +612,034 / −96,500 (for "vs" comparison lines).
   */
  sign?: SignStyle;
  /** Prefix a currency symbol. Off by default: units belong in the header. */
  symbol?: string;
  /** Render zero as an em dash (statement style). */
  zeroAsDash?: boolean;
}

export interface MoneyParts {
  /** The formatted figure including parentheses/sign. */
  text: string;
  negative: boolean;
  zero: boolean;
}

/** Format integer cents. See MoneyOptions. */
export function moneyParts(cents: number, opts: MoneyOptions = {}): MoneyParts {
  assertCents(cents);
  const { decimals = 2, sign = 'parens', symbol = '', zeroAsDash = false } = opts;
  const { whole, rem } = splitCents(cents);
  let body: string;
  let isZero: boolean;
  if (decimals === 0) {
    const rounded = whole + (rem >= 50 ? 1 : 0);
    isZero = rounded === 0;
    body = groupDigits(String(rounded));
  } else {
    isZero = cents === 0;
    body = `${groupDigits(String(whole))}.${pad2(rem)}`;
  }
  const negative = cents < 0 && !isZero;
  if (isZero && zeroAsDash) return { text: '—', negative: false, zero: true };
  const core = `${symbol}${body}`;
  let text: string;
  if (!negative) {
    text = sign === 'delta' && !isZero ? `+${core}` : core;
  } else if (sign === 'parens') {
    text = `(${core})`;
  } else {
    text = `${MINUS}${core}`;
  }
  return { text, negative, zero: isZero };
}

/** Integer cents → "3,184.62" / "(4,454.42)". */
export function money(cents: number, opts?: MoneyOptions): string {
  return moneyParts(cents, opts).text;
}

/**
 * Compact money for titles and dense strips: 612 · 8.4K · 84K · 1.2M · 12M.
 * Rounds half-up on integer cents; negatives in parentheses.
 */
export function compactMoney(cents: number, opts: { symbol?: string; sign?: SignStyle } = {}): string {
  assertCents(cents);
  const { symbol = '', sign = 'parens' } = opts;
  const abs = Math.abs(cents);
  const roundDiv = (n: number, d: number): number => {
    const r = n % d;
    return (n - r) / d + (r * 2 >= d ? 1 : 0);
  };
  let body: string;
  const dollars = roundDiv(abs, 100);
  if (dollars < 1_000) {
    body = String(dollars);
  } else if (dollars < 10_000) {
    const tenthsK = roundDiv(abs, 10_000); // 1 tenth of a thousand dollars = 10,000 cents
    body = `${(tenthsK - (tenthsK % 10)) / 10}.${tenthsK % 10}K`;
  } else if (dollars < 999_500) {
    body = `${roundDiv(abs, 100_000)}K`;
  } else if (dollars < 9_950_000) {
    const tenthsM = roundDiv(abs, 10_000_000);
    body = `${(tenthsM - (tenthsM % 10)) / 10}.${tenthsM % 10}M`;
  } else if (dollars < 999_500_000) {
    body = `${groupDigits(String(roundDiv(abs, 100_000_000)))}M`;
  } else {
    const tenthsB = roundDiv(abs, 10_000_000_000);
    body = `${(tenthsB - (tenthsB % 10)) / 10}.${tenthsB % 10}B`;
  }
  body = body.replace(/\.0([KMB])$/, '$1');
  const core = `${symbol}${body}`;
  if (cents < 0 && body !== '0') return sign === 'parens' ? `(${core})` : `${MINUS}${core}`;
  if (sign === 'delta' && cents > 0) return `+${core}`;
  return core;
}

/**
 * Parse user money input to integer cents without floats.
 * Accepts "1,234.5", "(1,234.50)", "-12", "$84", "−3.10". Returns null for
 * anything else, including more than two decimals.
 */
export function parseMoneyToCents(input: string): number | null {
  let s = input.trim().replace(/[$,\s]/g, '');
  if (s === '') return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-') || s.startsWith(MINUS)) {
    negative = !negative;
    s = s.slice(1);
  }
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const wholeStr = m[1] ?? '';
  const fracStr = m[2] ?? '';
  if (wholeStr === '' && fracStr === '') return null;
  const whole = wholeStr === '' ? 0 : Number(wholeStr);
  const frac = fracStr === '' ? 0 : Number(fracStr.length === 1 ? `${fracStr}0` : fracStr);
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents)) return null;
  return negative && cents !== 0 ? -cents : cents;
}

export interface PctOptions {
  /** Decimal places (default 1). */
  decimals?: number;
  /** parens (default) · minus · delta (+/−). */
  sign?: SignStyle;
}

/** A fraction (0.217) → "21.7%"; negatives "(2.7%)". Not for money math. */
export function pct(fraction: number, opts: PctOptions = {}): string {
  const { decimals = 1, sign = 'parens' } = opts;
  if (!Number.isFinite(fraction)) return '—';
  const scale = 10 ** decimals;
  const scaled = Math.round(Math.abs(fraction) * 100 * scale);
  const isZero = scaled === 0;
  const whole = Math.floor(scaled / scale);
  const frac = scaled % scale;
  const body = decimals > 0 ? `${groupDigits(String(whole))}.${String(frac).padStart(decimals, '0')}%` : `${groupDigits(String(whole))}%`;
  if (fraction < 0 && !isZero) return sign === 'parens' ? `(${body})` : `${MINUS}${body}`;
  if (sign === 'delta' && !isZero) return `+${body}`;
  return body;
}

/** Part/whole of two integer-cent amounts as a fraction (whole 0 → NaN). */
export function ratio(partCents: number, wholeCents: number): number {
  assertCents(partCents);
  assertCents(wholeCents);
  return wholeCents === 0 ? Number.NaN : partCents / wholeCents;
}

/** Percentage-point delta: −2.3 → "−2.3 pts", 1 → "+1.0 pts". */
export function pts(delta: number, decimals = 1): string {
  const scale = 10 ** decimals;
  const scaled = Math.round(Math.abs(delta) * scale);
  const body = `${Math.floor(scaled / scale)}${decimals > 0 ? `.${String(scaled % scale).padStart(decimals, '0')}` : ''} pts`;
  if (scaled === 0) return body;
  return delta < 0 ? `${MINUS}${body}` : `+${body}`;
}

/** Integer count with grouping: 1240 → "1,240". */
export function count(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(n);
  return r < 0 ? `${MINUS}${groupDigits(String(-r))}` : groupDigits(String(r));
}

/* ------------------------------------------------------------------ Dates
   One consistent format per screen (§8.5). English, fixed tables, local
   calendar dates. ISO date-only strings ("2026-10-19") are read as local
   calendar days, never shifted through UTC.                                 */

export type DateInput = Date | string | number;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Parse to a Date; date-only ISO strings become local midnight. */
export function toDate(input: DateInput): Date {
  if (input instanceof Date) return input;
  if (typeof input === 'number') return new Date(input);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(input);
}

/** "Oct 14" (adds the year when it differs from `ref`'s). */
export function shortDate(input: DateInput, ref?: DateInput): string {
  const d = toDate(input);
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (ref !== undefined && toDate(ref).getFullYear() !== d.getFullYear()) return `${base}, ${d.getFullYear()}`;
  return base;
}

/** "Mon Oct 19" — the context-line date. */
export function dayDate(input: DateInput): string {
  const d = toDate(input);
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "Oct 14, 2026". */
export function longDate(input: DateInput): string {
  const d = toDate(input);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "Sep 2026" (or "September 2026" with long). */
export function monthYear(input: DateInput, long = false): string {
  const d = toDate(input);
  return `${(long ? MONTHS_LONG : MONTHS)[d.getMonth()]} ${d.getFullYear()}`;
}

/** "9:38 AM". */
export function clockTime(input: DateInput): string {
  const d = toDate(input);
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(d.getMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

/** ISO-8601 week number (weeks start Monday; week 1 holds Jan 4). */
export function isoWeek(input: DateInput): number {
  const d = toDate(input);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** Whole calendar days from `from` to `to` (DST-safe). */
export function daysBetween(from: DateInput, to: DateInput): number {
  const a = toDate(from);
  const b = toDate(to);
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86_400_000);
}

/** "1 day" / "6 days". */
export function dayCount(n: number): string {
  return `${count(n)} ${Math.abs(n) === 1 ? 'day' : 'days'}`;
}

/** Remaining time as a countdown clock: 2520 s → "42:00", 3725 s → "1:02:05". */
export function countdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(sec)}` : `${m}:${pad2(sec)}`;
}
