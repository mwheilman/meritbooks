/**
 * Plain tables for every block (PDF export + pack attachment). Built from the SAME arrays
 * the screen charts draw (AC-W8). PURE.
 */

import type { CardModel, WsBlock } from './types';
import { formatMoney } from '@meritbooks/shared';
import { fmt } from './units';

export interface PrintTable {
  columns: string[];
  /** first column is the label; the rest are right-aligned figures */
  rows: string[][];
}

/** Card figures for print: compact money, signed change (built-in PDF fonts have no arrow glyphs). */
export function cardRow(c: CardModel): string[] {
  const sign = c.change ? (c.change.arrow === 'up' ? '+' : c.change.arrow === 'down' ? '-' : '') : '';
  const pts = c.change ? Math.abs(c.change.delta) * 100 : 0;
  const chg = c.change
    ? `${sign}${c.change.inPoints ? `${pts > 0 && pts < 0.1 ? pts.toFixed(2) : pts.toFixed(1)} pts` : c.change.pct !== null ? `${Math.abs(c.change.pct).toFixed(1)}%` : fmtCompact(Math.abs(c.change.delta), c.unit)} ${c.change.verdict}`
    : '';
  return [c.name, c.value === null ? (c.unavailable?.title ?? '—') : fmtCompact(c.value, c.unit), c.comparison ? fmtCompact(c.comparison.value, c.unit) : '', chg];
}

function fmtCompact(v: number | null, unit: CardModel['unit']): string {
  return unit === 'money' && v !== null ? formatMoney(Math.round(v), { compact: true }) : fmt(v, unit);
}

export function printTable(b: WsBlock): PrintTable | null {
  if (b.state) return null;
  switch (b.kind) {
    case 'series': {
      const cols = ['Month', 'Actual'];
      if (b.data.priorYear) cols.push('Prior year');
      if (b.data.budget) cols.push('Budget');
      if (b.data.ttm) cols.push('TTM');
      return {
        columns: cols,
        rows: b.data.periods.map((p, i) => [
          `${p.longLabel}${p.status === 'preliminary' ? ' (P)' : ''}`,
          fmt(b.data.actual[i], b.unit),
          ...(b.data.priorYear ? [fmt(b.data.priorYear[i], b.unit)] : []),
          ...(b.data.budget ? [fmt(b.data.budget[i], b.unit)] : []),
          ...(b.data.ttm ? [fmt(b.data.ttm[i], b.unit)] : []),
        ]),
      };
    }
    case 'multi_line':
      return { columns: ['Month', ...b.lines.map((l) => l.label)], rows: b.periods.map((p, i) => [p.longLabel, ...b.lines.map((l) => fmt(l.values[i], b.unit))]) };
    case 'yoy':
      return {
        columns: ['Line', b.headings.month, 'Year earlier', b.headings.fytd, 'Year earlier', 'TTM', 'Year earlier'],
        rows: b.rows.map((r) => [r.label, fmt(r.month.current, r.unit), fmt(r.month.prior, r.unit), fmt(r.fytd.current, r.unit), fmt(r.fytd.prior, r.unit), fmt(r.ttm.current, r.unit), fmt(r.ttm.prior, r.unit)]),
      };
    case 'cagr':
      return { columns: ['Line', '1 year', '3 years', '5 years'], rows: b.rows.map((r) => [r.label, ...r.rungs.map((g) => (g.value === null ? (g.unavailable?.title ?? '—') : fmt(g.value, 'percent')))]) };
    case 'seasonality':
      return { columns: ['Month', 'Index', 'This year'], rows: b.months.map((m) => [m.label, m.index === null ? '—' : m.index.toFixed(2), m.current === null ? '—' : m.current.toFixed(2)]) };
    case 'variance':
      return {
        columns: ['Line', 'Actual', b.planLabel, 'Variance', 'F/U'],
        rows: b.rows.map((r) => {
          const v = r.actual !== null && r.plan !== null ? r.actual - r.plan : null;
          const good = v === null || v === 0 ? '' : (r.direction === 'lower_is_better' ? v < 0 : v > 0) ? 'F' : 'U';
          return [`${r.label}${r.material ? ' *' : ''}`, fmt(r.actual, b.unit), fmt(r.plan, b.unit), fmt(v, b.unit), good];
        }),
      };
    case 'bridge':
      return { columns: ['Step', 'Amount'], rows: b.steps.map((s) => [s.label, fmt(s.value, 'money')]) };
    case 'aging':
      return { columns: ['', ...b.buckets.map((k) => k.label)], rows: b.rows.map((r) => [r.label, ...r.values.map((v) => fmt(v, 'money'))]) };
    case 'share': {
      const total = b.items.reduce((s, i) => s + Math.max(0, i.value ?? 0), 0);
      return { columns: [b.itemLabel, 'Amount', 'Share'], rows: [...b.items].sort((x, y) => (y.value ?? 0) - (x.value ?? 0)).slice(0, 15).map((i) => [i.label, fmt(i.value, b.unit), total > 0 && (i.value ?? 0) > 0 ? fmt((i.value ?? 0) / total, 'percent') : '—']) };
    }
    case 'league':
    case 'heat':
      return { columns: [b.rowHeading, ...b.columns.map((c) => c.label)], rows: b.rows.map((r) => [r.label, ...r.values.map((v, i) => fmt(v, b.columns[i].unit))]) };
    case 'scatter':
      return { columns: ['Company', b.xLabel, b.yLabel], rows: b.points.map((p) => [p.label, fmt(p.x, b.xUnit), fmt(p.y, b.yUnit)]) };
    case 'tiles':
      return { columns: ['Measure', 'Value', ''], rows: b.tiles.map((t) => [t.label, fmt(t.value, t.unit), t.sub]) };
    case 'gauges':
      return { columns: ['Covenant', 'Measured', 'Threshold', 'Headroom', 'Status'], rows: b.gauges.map((g) => [g.label, fmt(g.value, g.unit), fmt(g.threshold, g.unit), g.headroomPct === null ? '—' : fmt(g.headroomPct, 'percent'), g.band]) };
    default: {
      const never: never = b;
      return never;
    }
  }
}
