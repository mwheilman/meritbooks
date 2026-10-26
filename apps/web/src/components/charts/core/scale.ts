/**
 * Scales and ticks — small, pure, dependency-free (no d3 in the repo).
 *
 * Rules (FEATURE-GAP-AUDIT §4.4):
 *  - bars ALWAYS start at zero (`zero: true`);
 *  - ticks are "nice" (1 · 2 · 2.5 · 5 × 10ⁿ) and exact multiples of the step,
 *    so 0.1 + 0.2 never prints as 0.30000000000000004;
 *  - money ticks are whole dollars at minimum (`unitStep` = 100 cents);
 *  - the domain always contains every tick, so nothing draws off the plot.
 */

export interface NiceTicksOptions {
  /** Force the domain to include 0 (bars, waterfalls, variance). */
  zero?: boolean;
  /** Smallest permitted step (money: 100 cents = $1). */
  minStep?: number;
  /** Steps must be integers (counts, cents). */
  integer?: boolean;
}

export interface Ticks {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

import type { ChartUnit } from './types';

const NICE = [1, 2, 2.5, 5, 10] as const;

/** Round to 12 significant decimals to remove float noise from k × step. */
function clean(n: number): number {
  if (n === 0) return 0;
  const r = Math.round(n * 1e9) / 1e9;
  return Object.is(r, -0) ? 0 : r;
}

/** The nice step ≥ rough: 1, 2, 2.5, 5 × 10ⁿ. */
export function niceStep(rough: number, integer = false): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const exp = Math.floor(Math.log10(rough));
  const base = 10 ** exp;
  const f = rough / base;
  let step = base * 10;
  for (const n of NICE) {
    if (f <= n + 1e-9) {
      step = n * base;
      break;
    }
  }
  if (integer) {
    // 2.5 × 10⁰ is not an integer step; bump to 5.
    if (!Number.isInteger(clean(step))) step = step < 1 ? 1 : Math.ceil(step / 5) * 5;
    step = Math.max(1, Math.round(step));
  }
  return clean(step);
}

/**
 * Nice ticks covering [lo, hi] with about `count` intervals.
 * Handles all-negative, mixed-sign and flat (lo === hi) domains.
 */
export function niceTicks(lo: number, hi: number, count = 5, opts: NiceTicksOptions = {}): Ticks {
  let a = Math.min(lo, hi);
  let b = Math.max(lo, hi);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    a = 0;
    b = 1;
  }
  if (opts.zero) {
    a = Math.min(a, 0);
    b = Math.max(b, 0);
  }
  if (a === b) {
    // Flat series: open a band around the value (or 0..1 for all-zero).
    if (a === 0) b = opts.minStep ?? 1;
    else if (a > 0) {
      b = a * 1.25;
      a = opts.zero ? 0 : a * 0.75;
    } else {
      a = a * 1.25;
      b = opts.zero ? 0 : b * 0.75;
    }
  }
  const intervals = Math.max(1, Math.round(count));
  let step = niceStep((b - a) / intervals, opts.integer);
  if (opts.minStep && step < opts.minStep) step = opts.minStep;
  const min = clean(Math.floor(a / step + 1e-9) * step);
  const max = clean(Math.ceil(b / step - 1e-9) * step);
  const ticks: number[] = [];
  const n = Math.round((max - min) / step);
  for (let i = 0; i <= n; i++) ticks.push(clean(min + i * step));
  return { min, max: max === min ? clean(min + step) : max, step, ticks: ticks.length > 1 ? ticks : [min, clean(min + step)] };
}

/** Tick spec for a unit: money → whole-dollar minimum step; counts integer. */
export function ticksForUnit(
  lo: number,
  hi: number,
  unit: ChartUnit,
  count = 5,
  zero = false,
): Ticks {
  switch (unit) {
    case 'money':
      return niceTicks(lo, hi, count, { zero, minStep: 100, integer: true });
    case 'count':
    case 'days':
    case 'months':
      return niceTicks(lo, hi, count, { zero, integer: Math.abs(hi - lo) >= count });
    default:
      return niceTicks(lo, hi, count, { zero });
  }
}

export interface LinearScale {
  (v: number): number;
  domain: readonly [number, number];
  range: readonly [number, number];
  invert(px: number): number;
}

/** Linear map domain → range (range may be inverted for y). */
export function linearScale(domain: readonly [number, number], range: readonly [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const f = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as LinearScale;
  Object.defineProperty(f, 'domain', { value: domain });
  Object.defineProperty(f, 'range', { value: range });
  f.invert = (px: number) => d0 + ((px - r0) / ((r1 - r0) || 1)) * span;
  return f;
}

export interface BandScale {
  /** Left edge of band i. */
  x(i: number): number;
  /** Centre of band i. */
  mid(i: number): number;
  bandwidth: number;
  step: number;
  /** Index under a pixel (clamped). */
  indexAt(px: number): number;
  count: number;
}

/** Evenly spaced bands across [r0, r1]; paddingInner is a fraction of the step. */
export function bandScale(count: number, range: readonly [number, number], paddingInner = 0.3, paddingOuter = 0.15): BandScale {
  const [r0, r1] = range;
  const n = Math.max(1, count);
  const step = (r1 - r0) / Math.max(1e-9, n - paddingInner + paddingOuter * 2);
  const bandwidth = step * (1 - paddingInner);
  const start = r0 + step * paddingOuter;
  const x = (i: number) => start + i * step;
  return {
    x,
    mid: (i: number) => x(i) + bandwidth / 2,
    bandwidth,
    step,
    count: n,
    indexAt: (px: number) => Math.min(n - 1, Math.max(0, Math.floor((px - start + (step - bandwidth) / 2) / step))),
  };
}

/** Point positions for a line chart: n points spread edge to edge with an inset. */
export function pointScale(count: number, range: readonly [number, number], inset = 0.5): BandScale {
  // A band scale with no inner padding; points sit at band centres.
  return bandScale(count, range, 0, inset / 2);
}

/** [min, max] of the finite numbers across arrays, ignoring nulls (gaps). */
export function extent(...arrays: ReadonlyArray<ReadonlyArray<number | null | undefined> | undefined>): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const arr of arrays) {
    if (!arr) continue;
    for (const v of arr) {
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo === Infinity ? null : [lo, hi];
}

/**
 * Which axis labels to show when there is not room for all (every nth, always the last).
 * Pass the labels themselves and each slot is at least as wide as the widest label plus a gap,
 * so long labels ("Q3 FY27", "Sep 2026") thin out instead of overlapping.
 */
export function labelEvery(count: number, widthPx: number, minLabelPx = 36, labels?: ReadonlyArray<string>): number {
  if (count <= 1) return 1;
  const widest = labels && labels.length ? Math.max(...labels.map((l) => textWidth(l))) + 10 : 0;
  const slot = Math.max(minLabelPx, widest);
  const fit = Math.max(1, Math.floor(widthPx / slot));
  return Math.max(1, Math.ceil(count / fit));
}

/** Rough DM Sans 12px text width (px) — enough to reserve axis room without measuring. */
export function textWidth(s: string, px = 12): number {
  let w = 0;
  for (const ch of s) {
    if (/[0-9]/.test(ch)) w += 0.58;
    else if (/[,.:;()'’ ]/.test(ch)) w += 0.3;
    else if (/[MW%$]/.test(ch)) w += 0.82;
    else if (/[A-Z]/.test(ch)) w += 0.66;
    else w += 0.54;
  }
  return Math.ceil(w * px);
}
