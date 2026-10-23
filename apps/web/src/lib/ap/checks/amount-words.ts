/**
 * Check amounts in words and protected numerals — PURE.
 *
 * All input is integer cents (bigint-safe up to the check ceiling, $99,999,999.99).
 * Never floats: dollars and cents are split with integer arithmetic.
 *
 *   amountToWords(123456)  → "One Thousand Two Hundred Thirty-Four and 56/100"
 *   protectedAmount(123456) → "****1,234.56"   (fixed width, asterisk fill)
 *   wordsLine(123456, 80)   → "One Thousand … and 56/100 *********" (fills the line)
 */

/** The largest amount a check can carry: $99,999,999.99. */
export const MAX_CHECK_CENTS = 9_999_999_999;

const ONES = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
] as const;
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'] as const;
const SCALES = ['', 'Thousand', 'Million'] as const;

export class CheckAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckAmountError';
  }
}

function assertCheckCents(cents: number): void {
  if (!Number.isSafeInteger(cents)) throw new CheckAmountError('A check amount must be a whole number of cents.');
  if (cents <= 0) throw new CheckAmountError('A check amount must be greater than $0.00.');
  if (cents > MAX_CHECK_CENTS) throw new CheckAmountError('A check amount cannot exceed $99,999,999.99.');
}

/** 0–999 in words ("" for 0). */
function hundreds(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h > 0) parts.push(`${ONES[h]} Hundred`);
  if (rest > 0) {
    if (rest < 20) parts.push(ONES[rest]);
    else {
      const t = Math.floor(rest / 10);
      const o = rest % 10;
      parts.push(o === 0 ? TENS[t] : `${TENS[t]}-${ONES[o]}`);
    }
  }
  return parts.join(' ');
}

/** Whole dollars (0 … 99,999,999) in words. */
export function dollarsToWords(dollars: number): string {
  if (!Number.isSafeInteger(dollars) || dollars < 0) throw new CheckAmountError('Invalid dollar amount.');
  if (dollars === 0) return ONES[0];
  const groups: string[] = [];
  let rest = dollars;
  let scale = 0;
  while (rest > 0) {
    const chunk = rest % 1000;
    if (chunk > 0) {
      if (scale >= SCALES.length) throw new CheckAmountError('A check amount cannot exceed $99,999,999.99.');
      groups.unshift(SCALES[scale] ? `${hundreds(chunk)} ${SCALES[scale]}` : hundreds(chunk));
    }
    rest = Math.floor(rest / 1000);
    scale += 1;
  }
  return groups.join(' ');
}

/** "One Thousand Two Hundred Thirty-Four and 56/100" (no "Dollars": the stock prints it). */
export function amountToWords(cents: number): string {
  assertCheckCents(cents);
  const dollars = Math.floor(cents / 100);
  const c = cents % 100;
  return `${dollarsToWords(dollars)} and ${String(c).padStart(2, '0')}/100`;
}

/** "1,234.56" from integer cents. */
export function formatCheckNumeral(cents: number): string {
  const dollars = Math.floor(cents / 100);
  const c = String(cents % 100).padStart(2, '0');
  const withCommas = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${withCommas}.${c}`;
}

/**
 * The numeric amount box with protective asterisks to a fixed width
 * ("****1,234.56"), so digits can't be added in front. Width 14 fits $99,999,999.99.
 */
export function protectedAmount(cents: number, width = 14): string {
  assertCheckCents(cents);
  const n = formatCheckNumeral(cents);
  return n.length >= width ? n : `${'*'.repeat(width - n.length)}${n}`;
}

/**
 * The written line, padded with asterisks to `width` characters so nothing can be
 * written after it. Long amounts are returned unpadded (the renderer shrinks to fit).
 */
export function wordsLine(cents: number, width = 86): string {
  const w = amountToWords(cents);
  if (w.length + 2 >= width) return w;
  return `${w} ${'*'.repeat(width - w.length - 1)}`;
}
