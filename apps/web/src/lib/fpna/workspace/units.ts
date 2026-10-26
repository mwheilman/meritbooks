/**
 * Unit + wording helpers shared by the view builders, the PDF and the AI fact sheet.
 * PURE and server-safe (no chart-kit / merit-ui imports — those carry client modules).
 *
 * Registry presentation → workspace (chart-kit) units:
 *   money (cents) → money (cents) · percent / points (×100) → percent (fraction)
 *   times → multiple · ratio / count / days / months unchanged.
 */

import { formatMoney } from '@meritbooks/shared';
import { formatRatio } from '@/lib/format/ratio';
import { shortMonthLabel, type MonthKey } from '@/lib/analytics/months';
import type { MetricDirection, MetricUnit } from '@/lib/metrics/types';
import type { WsDirection, WsUnit, WsValue } from './types';

export function wsUnit(u: MetricUnit): WsUnit {
  switch (u) {
    case 'money':
      return 'money';
    case 'percent':
    case 'points':
      return 'percent';
    case 'times':
      return 'multiple';
    case 'ratio':
      return 'ratio';
    case 'days':
      return 'days';
    case 'months':
      return 'months';
    case 'count':
      return 'count';
    default: {
      const never: never = u;
      return never;
    }
  }
}

export function wsDirection(d: MetricDirection): WsDirection {
  return d === 'higher_better' ? 'higher_is_better' : d === 'lower_better' ? 'lower_is_better' : 'neutral';
}

/** Registry presentation value → workspace value (percent ÷ 100 → fraction). */
export function toWs(unit: MetricUnit, presentation: number | null | undefined): WsValue {
  if (presentation === null || presentation === undefined || !Number.isFinite(presentation)) return null;
  return unit === 'percent' || unit === 'points' ? presentation / 100 : presentation;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Aug 2026". */
export function longMonth(m: MonthKey | null | undefined): string {
  if (!m) return '—';
  const [y, mo] = m.split('-').map(Number);
  return `${MONTHS[mo - 1]} ${y}`;
}

/** "Aug" (axis). */
export function axisMonth(m: MonthKey): string {
  return MONTHS[Number(m.slice(5, 7)) - 1];
}

export { shortMonthLabel };

/** Plain text for one figure — the deterministic sentences, the PDF and the AI fact sheet share it. */
export function fmt(v: WsValue | undefined, unit: WsUnit): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  switch (unit) {
    case 'money':
      return formatMoney(Math.round(v));
    case 'percent':
      return `${(v * 100).toFixed(1)}%`;
    case 'multiple':
    case 'ratio':
      return formatRatio(v);
    case 'days':
      return `${Math.round(v)} days`;
    case 'months':
      return `${v.toFixed(1)} months`;
    case 'count':
    default:
      return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }
}

/** A signed change in words: "up $12,400.00 (13.1%)", "down 2.3 pts". */
export function changeWords(current: number, base: number, unit: WsUnit): string {
  const d = current - base;
  if (d === 0) return 'unchanged';
  const dir = d > 0 ? 'up' : 'down';
  if (unit === 'percent') return `${dir} ${(Math.abs(d) * 100).toFixed(1)} pts`;
  const abs = fmt(Math.abs(d), unit);
  if (base > 0 && Math.sign(current) === Math.sign(base)) return `${dir} ${abs} (${((Math.abs(d) / Math.abs(base)) * 100).toFixed(1)}%)`;
  return `${dir} ${abs}`;
}

/** Is the move good for this direction? null for neutral / flat. */
export function isGood(delta: number, direction: WsDirection): boolean | null {
  if (delta === 0 || direction === 'neutral') return null;
  return direction === 'higher_is_better' ? delta > 0 : delta < 0;
}
