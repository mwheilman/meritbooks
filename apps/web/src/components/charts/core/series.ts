/**
 * Series math — pure, tested. Gaps stay gaps; bridges must tie.
 */
import type { MetricDirection, Value } from './types';

export interface Segment {
  start: number;
  /** Inclusive. */
  end: number;
}

/**
 * Contiguous runs of non-null values. A null breaks the line — the kit never
 * interpolates across a missing month and never draws it as zero.
 */
export function segments(values: ReadonlyArray<Value | undefined>): Segment[] {
  const out: Segment[] = [];
  let start = -1;
  values.forEach((v, i) => {
    const has = v !== null && v !== undefined && Number.isFinite(v);
    if (has && start < 0) start = i;
    if (!has && start >= 0) {
      out.push({ start, end: i - 1 });
      start = -1;
    }
  });
  if (start >= 0) out.push({ start, end: values.length - 1 });
  return out;
}

/** Indexes whose value is missing (for footnotes: "Mar 2025 not on file"). */
export function gapIndexes(values: ReadonlyArray<Value | undefined>): number[] {
  const out: number[] = [];
  values.forEach((v, i) => {
    if (v === null || v === undefined || !Number.isFinite(v)) out.push(i);
  });
  return out;
}

/** Index of the last non-null value, or -1. */
export function lastIndex(values: ReadonlyArray<Value | undefined>): number {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return i;
  }
  return -1;
}

/**
 * Trailing sum over `window` periods. Refuses to invent: if any of the window is
 * missing, the result is null (an 11-month "TTM" is not a TTM).
 */
export function trailingSum(values: ReadonlyArray<Value>, window = 12): Value[] {
  return values.map((_, i) => {
    if (i < window - 1) return null;
    let s = 0;
    for (let k = i - window + 1; k <= i; k++) {
      const v = values[k];
      if (v === null || !Number.isFinite(v)) return null;
      s += v;
    }
    return s;
  });
}

// ─────────────────────────────────────────────────────────── waterfall / bridge

export type BridgeKind = 'start' | 'delta' | 'subtotal' | 'end';

export interface BridgeStep {
  key: string;
  label: string;
  kind: BridgeKind;
  /**
   * start / end: the anchor's absolute value. delta: the signed movement.
   * subtotal: ignored — always the computed running total (pass 0).
   */
  value: number;
  /** For deltas whose sign isn't the good direction (e.g. a cost bridge). */
  direction?: MetricDirection;
  sub?: string;
}

export interface BridgeBar {
  key: string;
  label: string;
  kind: BridgeKind;
  sub?: string;
  /** Bar spans [from, to] on the value axis. */
  from: number;
  to: number;
  /** Signed movement (deltas) or anchor value. */
  value: number;
  /** Running total after this step. */
  running: number;
  favourable: boolean | null;
}

export interface Bridge {
  bars: BridgeBar[];
  /** The end anchor equals start + Σ deltas (within 1 cent). */
  ties: boolean;
  /** end anchor − computed running total (cents); 0 when it ties. */
  difference: number;
}

/**
 * Running totals for a bridge (EBITDA, cash, working capital). Anchors sit on
 * zero; deltas float from the running total. An `end` that does not equal
 * start + Σ deltas is reported (ties = false) — a bridge that doesn't tie is a
 * bug in the producer, and the card shows it rather than hiding it.
 */
export function computeBridge(steps: ReadonlyArray<BridgeStep>, defaultDirection: MetricDirection = 'higher_is_better'): Bridge {
  const bars: BridgeBar[] = [];
  let running = 0;
  let difference = 0;
  for (const s of steps) {
    if (s.kind === 'start') {
      running = s.value;
      bars.push({ key: s.key, label: s.label, kind: s.kind, sub: s.sub, from: 0, to: s.value, value: s.value, running, favourable: null });
    } else if (s.kind === 'delta') {
      const from = running;
      running += s.value;
      const dir = s.direction ?? defaultDirection;
      const favourable = dir === 'neutral' || s.value === 0 ? null : dir === 'higher_is_better' ? s.value > 0 : s.value < 0;
      bars.push({ key: s.key, label: s.label, kind: s.kind, sub: s.sub, from, to: running, value: s.value, running, favourable });
    } else {
      // subtotal: an anchor at the running total. end: the producer's figure, checked.
      const supplied = s.kind === 'end' ? s.value : running;
      const diff = supplied - running;
      if (Math.abs(diff) > 1) difference = diff;
      bars.push({ key: s.key, label: s.label, kind: s.kind, sub: s.sub, from: 0, to: supplied, value: supplied, running: supplied, favourable: null });
      running = supplied;
    }
  }
  return { bars, ties: difference === 0, difference };
}

/** The largest delta by magnitude (for "The largest step is …"). */
export function largestStep(b: Bridge): BridgeBar | null {
  let best: BridgeBar | null = null;
  for (const bar of b.bars) if (bar.kind === 'delta' && (!best || Math.abs(bar.value) > Math.abs(best.value))) best = bar;
  return best;
}

// ─────────────────────────────────────────────────────────── stacking

export interface StackCell {
  /** Lower and upper bound on the value axis. */
  y0: number;
  y1: number;
  value: Value;
}

/**
 * Diverging stack: positives stack up from 0, negatives stack down from 0, nulls
 * take no space. Returns [series][category].
 */
export function stack(series: ReadonlyArray<ReadonlyArray<Value>>, categories: number): StackCell[][] {
  const up = new Array<number>(categories).fill(0);
  const down = new Array<number>(categories).fill(0);
  return series.map((vals) =>
    Array.from({ length: categories }, (_, i) => {
      const v = vals[i] ?? null;
      if (v === null || !Number.isFinite(v)) return { y0: up[i], y1: up[i], value: null };
      if (v >= 0) {
        const c = { y0: up[i], y1: up[i] + v, value: v };
        up[i] += v;
        return c;
      }
      const c = { y0: down[i] + v, y1: down[i], value: v };
      down[i] += v;
      return c;
    }),
  );
}

/** Stack totals per category (positives + negatives), and the stacked extent. */
export function stackExtent(cells: StackCell[][]): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const s of cells) for (const c of s) {
    lo = Math.min(lo, c.y0);
    hi = Math.max(hi, c.y1);
  }
  return [lo, hi];
}

// ─────────────────────────────────────────────────────────── variance

export interface Variance {
  delta: number;
  rel: number | null;
  favourable: boolean | null;
}

/** actual − plan, favourable by direction; relative n/m when plan ≤ 0. */
export function variance(actual: number, plan: number, direction: MetricDirection): Variance {
  const delta = actual - plan;
  const rel = plan > 0 ? delta / plan : null;
  const favourable = direction === 'neutral' || delta === 0 ? null : direction === 'higher_is_better' ? delta > 0 : delta < 0;
  return { delta, rel, favourable };
}

// ─────────────────────────────────────────────────────────── shares & ranks

export interface ShareItem {
  key: string;
  label: string;
  value: number;
  share: number;
  /** A negative contributor (a loss) — drawn hatched, excluded from the 100%. */
  loss: boolean;
}

/**
 * Shares of the POSITIVE total. Losses are listed separately (hatched) — mixing a
 * negative into a 100% bar would invent a share. Top-N then "Other".
 */
export function shares(items: ReadonlyArray<{ key: string; label: string; value: Value }>, topN = 8, otherLabel = 'All others'): {
  items: ShareItem[];
  total: number;
  lossTotal: number;
} {
  const valid = items.filter((i): i is { key: string; label: string; value: number } => i.value !== null && Number.isFinite(i.value));
  const pos = valid.filter((i) => i.value > 0).sort((a, b) => b.value - a.value);
  const neg = valid.filter((i) => i.value < 0).sort((a, b) => a.value - b.value);
  const total = pos.reduce((s, i) => s + i.value, 0);
  const lossTotal = neg.reduce((s, i) => s + i.value, 0);
  const head = pos.slice(0, topN);
  const rest = pos.slice(topN);
  const out: ShareItem[] = head.map((i) => ({ ...i, share: total > 0 ? i.value / total : 0, loss: false }));
  if (rest.length) {
    const v = rest.reduce((s, i) => s + i.value, 0);
    out.push({ key: '__other', label: `${otherLabel} (${rest.length})`, value: v, share: total > 0 ? v / total : 0, loss: false });
  }
  for (const n of neg) out.push({ ...n, share: 0, loss: true });
  return { items: out, total, lossTotal };
}

/**
 * Percentile rank (0..1, 1 = best) of each value within its column, honouring
 * direction. Nulls stay null. Ties share the mean rank.
 */
export function percentileRanks(values: ReadonlyArray<Value>, direction: MetricDirection): Value[] {
  const idx = values
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => x.v !== null && Number.isFinite(x.v));
  if (direction === 'neutral' || idx.length === 0) return values.map(() => null);
  if (idx.length === 1) return values.map((v) => (v === null ? null : 0.5));
  const sorted = [...idx].sort((a, b) => (direction === 'higher_is_better' ? a.v - b.v : b.v - a.v));
  const out: Value[] = values.map(() => null);
  let k = 0;
  while (k < sorted.length) {
    let j = k;
    while (j + 1 < sorted.length && sorted[j + 1].v === sorted[k].v) j++;
    const rank = (k + j) / 2 / (sorted.length - 1);
    for (let m = k; m <= j; m++) out[sorted[m].i] = rank;
    k = j + 1;
  }
  return out;
}
