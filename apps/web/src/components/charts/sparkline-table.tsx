'use client';

/**
 * SparklineTable — rows of metrics (or companies, or statement lines) with a
 * 12-period sparkline, the latest figure and the change (E-REPORTING U6).
 * Sortable on the figure columns; rows drill on click / Enter.
 * `SparkRow` is exported for tables that bring their own columns.
 */
import { useMemo, useState } from 'react';
import { ChangeChip } from './change-chip';
import { compare, formatValue } from './core/format';
import { lastIndex } from './core/series';
import type { ChartTable } from './core/table';
import type { ChartUnit, MetricDirection, PeriodStatus, Value } from './core/types';
import { Sparkline } from './sparkline';

export interface SparkTableRow {
  key: string;
  label: string;
  sub?: string;
  unit: ChartUnit;
  direction: MetricDirection;
  series: ReadonlyArray<Value>;
  statuses?: ReadonlyArray<PeriodStatus | undefined>;
  /** Latest value; default: the last non-null of series. */
  latest?: Value;
  /** Comparison base (prior year / budget). */
  base?: Value;
}

export interface SparklineTableProps {
  rows: ReadonlyArray<SparkTableRow>;
  /** Period labels shared by every series. */
  periodLabels?: ReadonlyArray<string>;
  /** Column heading for the label column ("Metric", "Company", "Account"). */
  labelHeading?: string;
  latestHeading?: string;
  baseLabel?: string;
  caption: string;
  onDrill?: (rowKey: string) => void;
  /** Dense (cockpit) rows. */
  dense?: boolean;
}

function latestOf(r: SparkTableRow): Value {
  if (r.latest !== undefined) return r.latest;
  const i = lastIndex(r.series);
  return i >= 0 ? (r.series[i] as number) : null;
}

/** The table export for a SparklineTable (series flattened to columns). */
export function sparkTableData(rows: ReadonlyArray<SparkTableRow>, opts: { caption: string; periodLabels?: ReadonlyArray<string>; labelHeading?: string; baseLabel?: string }): ChartTable {
  const n = Math.max(0, ...rows.map((r) => r.series.length));
  const periods = Array.from({ length: n }, (_, i) => opts.periodLabels?.[i] ?? `P${i + 1}`);
  // Mixed units across rows: one table per unit would be purer, but a metric
  // sheet is read row-wise; we tag each money/percent cell by the row's unit by
  // formatting figures as text for non-money rows.
  return {
    caption: opts.caption,
    columns: [{ key: 'label', label: opts.labelHeading ?? 'Metric' }, ...periods.map((p, i) => ({ key: `p${i}`, label: p })), { key: 'base', label: opts.baseLabel ?? 'Base' }],
    rows: rows.map((r) => ({
      key: r.key,
      cells: [r.label, ...Array.from({ length: n }, (_, i) => formatValue(r.series[i] ?? null, r.unit)), formatValue(r.base ?? null, r.unit)],
    })),
  };
}

type SortKey = 'label' | 'latest' | 'change';

export function SparkRow({
  row,
  periodLabels,
  baseLabel,
  onDrill,
}: {
  row: SparkTableRow;
  periodLabels?: ReadonlyArray<string>;
  baseLabel: string;
  onDrill?: (key: string) => void;
}) {
  const latest = latestOf(row);
  const drill = onDrill ? () => onDrill(row.key) : undefined;
  return (
    <tr className={drill ? 'is-link' : undefined} onClick={drill} onKeyDown={drill ? (e) => (e.key === 'Enter' ? drill() : undefined) : undefined} tabIndex={drill ? 0 : undefined}>
      <th scope="row">
        <span className="l1">{row.label}</span>
        {row.sub && <span className="l2">{row.sub}</span>}
      </th>
      <td className="mc-st-spark">
        <Sparkline values={row.series} unit={row.unit} metric={row.label} labels={periodLabels} statuses={row.statuses} width={112} height={24} />
      </td>
      <td className="n">{formatValue(latest, row.unit, { compact: row.unit === 'money' })}</td>
      <td className="n">
        {latest !== null && row.base !== null && row.base !== undefined ? (
          <ChangeChip current={latest} base={row.base} unit={row.unit} direction={row.direction} baseLabel={baseLabel} quiet />
        ) : (
          <span className="ink-3">n/m</span>
        )}
      </td>
    </tr>
  );
}

export function SparklineTable({ rows, periodLabels, labelHeading = 'Metric', latestHeading = 'Latest', baseLabel = 'prior year', caption, onDrill, dense }: SparklineTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const val = (r: SparkTableRow): number | string => {
      if (sort.key === 'label') return r.label.toLowerCase();
      const l = latestOf(r);
      if (sort.key === 'latest') return l ?? -Infinity;
      if (l === null || r.base === null || r.base === undefined) return -Infinity;
      const c = compare(l, r.base, r.direction, r.unit);
      // Sort change by "goodness": improvements first when descending.
      const mag = c.rel ?? c.delta;
      return c.favourable === null ? mag : c.favourable ? Math.abs(mag) : -Math.abs(mag);
    };
    return [...rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [rows, sort]);

  const head = (key: SortKey, label: string, numeric: boolean) => {
    const on = sort?.key === key;
    return (
      <th scope="col" className={numeric ? 'n' : undefined} aria-sort={on ? (sort?.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className="mc-sort" onClick={() => setSort((s) => (s?.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'label' ? 1 : -1 }))}>
          {label}
          <span aria-hidden="true">{on ? (sort?.dir === 1 ? '↑' : '↓') : ''}</span>
        </button>
      </th>
    );
  };

  return (
    <div className="mc-tbl-wrap">
      <table className={`mc-tbl mc-st${dense ? ' mc-st--dense' : ''}`}>
        <caption className="sr">{caption}</caption>
        <thead>
          <tr>
            {head('label', labelHeading, false)}
            <th scope="col">Trend</th>
            {head('latest', latestHeading, true)}
            {head('change', `vs ${baseLabel}`, true)}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <SparkRow key={r.key} row={r} periodLabels={periodLabels} baseLabel={baseLabel} onDrill={onDrill} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
