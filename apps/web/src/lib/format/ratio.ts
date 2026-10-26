/**
 * THE ratio formatter (PURE, server + client safe). Every ratio / multiple in Books — the
 * balance sheet's current ratio, liquidity and leverage KPIs, coverage multiples, charts —
 * prints as a multiple with the multiplication sign: "0.62×", "1.25×", "−0.40×". Never as a
 * percent (a current ratio of 0.625 is not "62.5%").
 */

export const TIMES = '×';
const MINUS = '−';

export interface RatioFormat {
  /** Decimal places (default 2). Trailing zero after one decimal is kept: "2.40×". */
  decimals?: number;
  /** Signed change ("+0.10×" / "−0.05×"). */
  delta?: boolean;
  /** Text for null / non-finite (default "—"). */
  empty?: string;
  /** Drop one trailing zero after the decimal point: "2.40×" → "2.4×" (covenant style). */
  trimZero?: boolean;
}

export function formatRatio(v: number | null | undefined, opts: RatioFormat = {}): string {
  const { decimals = 2, delta = false, empty = '—', trimZero = false } = opts;
  if (v === null || v === undefined || !Number.isFinite(v)) return empty;
  let fixed = Math.abs(v).toFixed(decimals);
  if (trimZero) fixed = fixed.replace(/(\.\d)0$/, '$1');
  const [w, f] = fixed.split('.');
  const body = `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}${TIMES}`;
  if (Number(fixed) === 0) return `${f ? `0.${f}` : '0'}${TIMES}`;
  if (v < 0) return `${MINUS}${body}`;
  return delta ? `+${body}` : body;
}
