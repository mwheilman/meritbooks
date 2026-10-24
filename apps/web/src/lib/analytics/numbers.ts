/**
 * Numeric primitives shared by the analytics library and the metric evaluator.
 *
 * Money is integer cents (JS numbers are exact to 2^53 cents ≈ $90 trillion).
 * Ratios are plain fractions (0.25 = 25%). Anything that can't be stated honestly
 * returns `null` with a reason instead of 0, Infinity or NaN.
 */

export type NotMeaningfulReason = 'zero_base' | 'negative_base' | 'sign_flip' | 'non_positive';

export interface Rate {
  value: number | null;
  reason?: NotMeaningfulReason;
}

/** Round to `dp` decimals without float noise (half away from zero). */
export function roundTo(n: number, dp: number): number {
  const f = 10 ** dp;
  const r = Math.round(Math.abs(n) * f + Number.EPSILON * f) / f;
  if (r === 0) return 0;
  return n < 0 ? -r : r;
}

/** Round half away from zero to an integer (cents). Math.round rounds −0.5 to −0. */
export function roundCents(n: number): number {
  const r = Math.round(Math.abs(n));
  if (r === 0) return 0;
  return n < 0 ? -r : r;
}

export function sum(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}

/** Sample standard deviation (n − 1). Null below two points. */
export function stdev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = sum(values) / values.length;
  let ss = 0;
  for (const v of values) ss += (v - m) ** 2;
  return Math.sqrt(ss / (values.length - 1));
}

/** part ÷ whole, null when whole is 0. */
export function safeRatio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

/**
 * Growth (current − base) ÷ |base| with the portal's n/m rules: a zero or negative
 * base is not meaningful, and so is a sign flip (profit → loss), because a % change
 * across zero misleads.
 */
export function growthRate(current: number, base: number): Rate {
  if (base === 0) return { value: null, reason: 'zero_base' };
  if (base < 0) return { value: null, reason: 'negative_base' };
  if (current < 0) return { value: null, reason: 'sign_flip' };
  return { value: (current - base) / base };
}

/**
 * Compound annual growth rate over `years` from `start` to `end`. Both ends must be
 * positive (a CAGR through a loss year is meaningless).
 */
export function cagr(end: number, start: number, years: number): Rate {
  if (years <= 0) throw new Error('CAGR needs a positive number of years');
  if (start <= 0 || end <= 0) return { value: null, reason: 'non_positive' };
  return { value: (end / start) ** (1 / years) - 1 };
}

/**
 * Split `total` (integer cents) into integer parts proportional to `weights`
 * using the largest-remainder method, so the parts always sum to `total` exactly.
 * Ties break toward the earlier index (deterministic).
 */
export function allocateCents(total: number, weights: readonly number[]): number[] {
  if (!Number.isInteger(total)) throw new Error('allocateCents: total must be integer cents');
  if (weights.length === 0) return [];
  const wSum = sum(weights.map((w) => Math.abs(w)));
  if (wSum === 0) {
    const out = weights.map(() => 0);
    out[0] = total;
    return out;
  }
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const raw = weights.map((w) => (abs * Math.abs(w)) / wSum);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = abs - sum(floors);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors.map((f) => (f === 0 ? 0 : sign * f));
}

/**
 * Round a list of fractional cent amounts to integers that sum to the rounded
 * total (largest remainder on signed values). Used by bridges so the printed
 * steps always tie.
 */
export function roundPreservingSum(values: readonly number[], target?: number): number[] {
  const total = target ?? roundCents(sum(values));
  const floors = values.map((v) => Math.floor(v));
  let remainder = total - sum(floors);
  const order = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = [...floors];
  let k = 0;
  while (remainder > 0 && order.length > 0) {
    out[order[k % order.length].i] += 1;
    remainder -= 1;
    k += 1;
  }
  k = order.length - 1;
  while (remainder < 0 && order.length > 0) {
    out[order[((k % order.length) + order.length) % order.length].i] -= 1;
    remainder += 1;
    k -= 1;
  }
  return out.map((v) => (v === 0 ? 0 : v));
}
