/**
 * Chart number formatting — built on the merit-ui figure helpers (integer-cents
 * safe, identical on server and client), never on float money math.
 *
 *  - axis ticks:   compact, one scale for the whole axis ("$0 · $500K · $1M · $1.5M")
 *  - exact values: tooltips, tables, sentences ("$1,234,567")
 *  - deltas:       signed (+$12K / −$8K), margins in points (+1.4 pts)
 */
import { compactMoney, money, pct, pts } from '@meritbooks/merit-ui';
import type { ChartUnit, MetricDirection, Value } from './types';
import { formatRatio, TIMES } from '@/lib/format/ratio';

const MINUS = '−';

function cents(v: number): number {
  // The kit's money helpers assert integer cents. Producers must hand cents; we
  // round defensively at the edge so a stray .5 from an average can't throw.
  return Math.round(v);
}

function plainNumber(v: number, decimals: number): string {
  const fixed = Math.abs(v).toFixed(decimals);
  const [w, f] = fixed.split('.');
  const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = f ? `${grouped}.${f}` : grouped;
  return v < 0 && Number(fixed) !== 0 ? `${MINUS}${body}` : body;
}

export interface FormatOptions {
  /** Compact ($1.2M) instead of exact ($1,234,567). */
  compact?: boolean;
  /** Sign style for deltas: '+$12K' / '−$8K'. */
  delta?: boolean;
  /** Decimals for percent/ratio (default 1). */
  decimals?: number;
}

/** One value in its unit. Null → em dash (a gap is never printed as 0). */
export function formatValue(v: Value | undefined, unit: ChartUnit, opts: FormatOptions = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const { compact = false, delta = false, decimals = 1 } = opts;
  switch (unit) {
    case 'money': {
      const c = cents(v);
      if (compact) return compactMoney(c, { symbol: '$', sign: delta ? 'delta' : 'parens' });
      return money(c, { symbol: '$', decimals: Math.abs(c) >= 100_000 ? 0 : 2, sign: delta ? 'delta' : 'parens' });
    }
    case 'percent':
      return pct(v, { decimals, sign: delta ? 'delta' : 'minus' });
    case 'multiple':
      // Covenants live at two decimals (1.25×); "2.40×" reads as "2.4×". One ratio formatter.
      return formatRatio(v, { decimals: opts.decimals ?? 2, delta, trimZero: true });
    case 'ratio':
      return formatRatio(v, { decimals: opts.decimals ?? 2, delta });
    case 'days':
      return `${delta && v > 0 ? '+' : ''}${plainNumber(v, 0)} ${Math.abs(Math.round(v)) === 1 ? 'day' : 'days'}`;
    case 'months':
      return `${delta && v > 0 ? '+' : ''}${plainNumber(v, 1)} mo`;
    case 'count':
    default:
      return `${delta && v > 0 ? '+' : ''}${plainNumber(v, Number.isInteger(v) ? 0 : decimals)}`;
  }
}

/**
 * Axis tick labels: one consistent compact scale across the axis, so ticks read
 * "$0 · $250K · $500K", never "$0 · $250,000 · $0.5M".
 */
export function axisLabels(ticks: readonly number[], unit: ChartUnit): string[] {
  // Fewest decimals that print every tick EXACTLY (2.5% must not read "3%").
  const exactAt = (vals: number[], d: number) => vals.every((v) => Math.abs(Number(v.toFixed(d)) - v) < 1e-9);
  const decimalsFor = (vals: number[]) => [0, 1, 2].find((d) => exactAt(vals, d)) ?? 2;
  if (unit === 'money') {
    const maxAbs = Math.max(...ticks.map((t) => Math.abs(t)));
    const dollars = maxAbs / 100;
    const div = dollars >= 1_000_000 ? 1_000_000 : dollars >= 10_000 ? 1_000 : 1;
    const suffix = div === 1_000_000 ? 'M' : div === 1_000 ? 'K' : '';
    const scaled = ticks.map((t) => t / 100 / div);
    const d = decimalsFor(scaled);
    return scaled.map((n, i) => {
      if (ticks[i] === 0) return '$0';
      const s = `$${plainNumber(Math.abs(n), d)}${suffix}`;
      return n < 0 ? `${MINUS}${s}` : s;
    });
  }
  if (unit === 'percent') {
    const d = decimalsFor(ticks.map((t) => t * 100));
    return ticks.map((t) => pct(t, { decimals: d, sign: 'minus' }));
  }
  if (unit === 'multiple') {
    const d = decimalsFor([...ticks]);
    return ticks.map((t) => `${plainNumber(t, d)}${TIMES}`);
  }
  const d = decimalsFor([...ticks]);
  return ticks.map((t) => plainNumber(t, d));
}

/** Delta in the unit; percent-unit deltas are in points. */
export function formatDelta(delta: number, unit: ChartUnit, compact = true): string {
  if (unit === 'percent') return pts(delta * 100);
  return formatValue(delta, unit, { compact, delta: true });
}

export type ChangeTone = 'improvement' | 'erosion' | 'flat' | 'neutral';

export interface Change {
  delta: number;
  /** Relative change (fraction) — null when not meaningful (base ≤ 0, sign flip). */
  rel: number | null;
  tone: ChangeTone;
  /** 'up' / 'down' / 'flat' — literal movement, independent of good/bad. */
  move: 'up' | 'down' | 'flat';
  favourable: boolean | null;
}

/**
 * Compare current to base, honouring the metric's direction.
 * Relative change is n/m when the base is ≤ 0 or the sign flips (portal rule).
 * Percent-unit metrics never get a relative change — they move in points.
 */
export function compare(current: number, base: number, direction: MetricDirection, unit: ChartUnit): Change {
  const delta = current - base;
  const flatEps = unit === 'money' ? 50 : unit === 'percent' ? 0.0005 : 1e-9;
  const move: Change['move'] = Math.abs(delta) < flatEps ? 'flat' : delta > 0 ? 'up' : 'down';
  let rel: number | null = null;
  if (unit !== 'percent' && base > 0 && current >= 0) rel = delta / base;
  let favourable: boolean | null = null;
  let tone: ChangeTone = 'neutral';
  if (move === 'flat') tone = 'flat';
  else if (direction !== 'neutral') {
    favourable = direction === 'higher_is_better' ? delta > 0 : delta < 0;
    tone = favourable ? 'improvement' : 'erosion';
  }
  return { delta, rel, tone, move, favourable };
}

/** "up 13.1%" / "down $8K" / "up 1.4 pts" / "flat" — for sentences. */
export function changePhrase(c: Change, unit: ChartUnit): string {
  if (c.move === 'flat') return 'flat';
  const verb = c.move === 'up' ? 'up' : 'down';
  if (unit === 'percent') return `${verb} ${pts(Math.abs(c.delta) * 100).replace(/^[+−]/, '')}`;
  if (c.rel !== null) return `${verb} ${pct(Math.abs(c.rel), { decimals: 1 })}`;
  return `${verb} ${formatValue(Math.abs(c.delta), unit, { compact: true })}`;
}

/** F / U label for a variance (or '' for neutral metrics). */
export function fuLabel(favourable: boolean | null): '' | 'F' | 'U' {
  if (favourable === null) return '';
  return favourable ? 'F' : 'U';
}

/** File-name-safe slug. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'chart';
}
