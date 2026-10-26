'use client';

/** Client formatting for /fpna — the chart kit's formatter (merit-ui figures), one place. */
import { formatValue } from '@/components/charts';
import type { CardModel, WsUnit, WsValue } from '@/lib/fpna/workspace/types';

export function valueText(v: WsValue | undefined, unit: WsUnit, compact = true): string {
  return formatValue(v ?? null, unit, { compact: compact && unit === 'money' });
}

export function changeText(c: CardModel): string {
  const ch = c.change;
  if (!ch) return '';
  if (ch.arrow === 'flat') return c.unit === 'percent' ? '0.0 pts' : '0.0%';
  if (ch.inPoints) {
    const pts = Math.abs(ch.delta) * 100;
    return `${pts > 0 && pts < 0.1 ? pts.toFixed(2) : pts.toFixed(1)} pts`;
  }
  if (ch.pct !== null) return `${Math.abs(ch.pct) > 0 && Math.abs(ch.pct) < 0.1 ? '<0.1' : Math.abs(ch.pct).toFixed(1)}%`;
  return formatValue(Math.abs(ch.delta), c.unit, { compact: true });
}

export function monthName(m: string | null | undefined): string {
  if (!m) return '—';
  const [y, mo] = m.split('-').map(Number);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mo - 1]} ${y}`;
}

export function monthStartIso(m: string): string {
  return `${m}-01`;
}

export function monthEndIso(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

/** "YTD Jan – Sep 2026", "Sep 2026", "TTM Oct 2025 – Sep 2026". */
export function windowText(basis: string, from: string, to: string): string {
  const b = basis.toUpperCase();
  if (from === to) return `${b === 'MONTH' ? '' : `${b} `}${monthName(to)}`;
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  const f = sameYear ? monthName(from).slice(0, 3) : monthName(from);
  return `${b} ${f} – ${monthName(to)}`;
}
