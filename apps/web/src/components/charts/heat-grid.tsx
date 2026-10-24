'use client';

/**
 * HeatGrid — companies × KPIs (E-REPORTING U10, Fathom company ranking).
 * Each column is ranked within itself, honouring that column's direction; the
 * cell tint is the rank quintile (Sky → Electric for better, brick wash for the
 * bottom fifth) and the figure is ALWAYS printed, so the grid reads without
 * colour. n/m cells are hatched grey and say why. Arrow keys move cell to cell.
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { formatValue } from './core/format';
import { useChartCard } from './core/hooks';
import { percentileRanks } from './core/series';
import type { ChartTable } from './core/table';
import type { ChartUnit, MetricDirection, Value } from './core/types';

export interface HeatColumn {
  key: string;
  label: string;
  unit: ChartUnit;
  direction: MetricDirection;
}

export interface HeatRow {
  key: string;
  label: string;
  sub?: string;
  values: Value[];
}

export interface HeatGridProps {
  columns: ReadonlyArray<HeatColumn>;
  rows: ReadonlyArray<HeatRow>;
  rowHeading?: string;
  caption: string;
  onDrill?: (rowKey: string, columnKey: string) => void;
}

export function heatBand(rank: Value): 'na' | 'q1' | 'q2' | 'q3' | 'q4' | 'q5' {
  if (rank === null) return 'na';
  if (rank >= 0.8) return 'q5';
  if (rank >= 0.6) return 'q4';
  if (rank >= 0.4) return 'q3';
  if (rank >= 0.2) return 'q2';
  return 'q1';
}

export function heatTable(columns: ReadonlyArray<HeatColumn>, rows: ReadonlyArray<HeatRow>, caption: string, rowHeading = 'Company'): ChartTable {
  return {
    caption,
    columns: [{ key: 'row', label: rowHeading }, ...columns.map((c) => ({ key: c.key, label: c.label, unit: c.unit }))],
    rows: rows.map((r) => ({ key: r.key, cells: [r.label, ...columns.map((_, j) => r.values[j] ?? null)] })),
  };
}

export function HeatGrid({ columns, rows, rowHeading = 'Company', caption, onDrill }: HeatGridProps) {
  const { labelledBy } = useChartCard();
  const ranks = useMemo(() => columns.map((c, j) => percentileRanks(rows.map((r) => r.values[j] ?? null), c.direction)), [columns, rows]);
  const [cur, setCur] = useState<[number, number]>([0, 0]);
  const refs = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const focus = useCallback((r: number, c: number) => {
    setCur([r, c]);
    refs.current.get(`${r}:${c}`)?.focus();
  }, []);
  const onKey = (e: KeyboardEvent, r: number, c: number) => {
    const map: Record<string, [number, number]> = { ArrowRight: [r, c + 1], ArrowLeft: [r, c - 1], ArrowDown: [r + 1, c], ArrowUp: [r - 1, c], Home: [r, 0], End: [r, columns.length - 1] };
    const to = map[e.key];
    if (to) {
      e.preventDefault();
      const [nr, nc] = to;
      if (nr >= 0 && nr < rows.length && nc >= 0 && nc < columns.length) focus(nr, nc);
    } else if ((e.key === 'Enter' || e.key === ' ') && onDrill) {
      e.preventDefault();
      onDrill(rows[r].key, columns[c].key);
    }
  };
  const word = (b: ReturnType<typeof heatBand>) => (b === 'q5' ? 'top fifth' : b === 'q4' ? 'second fifth' : b === 'q3' ? 'middle fifth' : b === 'q2' ? 'fourth fifth' : b === 'q1' ? 'bottom fifth' : 'not ranked');
  return (
    <div className="mc-tbl-wrap mc-heat-wrap" role="group" aria-labelledby={labelledBy}>
      <table className="mc-heat" role="grid" aria-label={labelledBy ? undefined : caption}>
        <caption className="sr">{caption}. Cells are ranked within each column; the best fifth is darkest blue.</caption>
        <thead>
          <tr>
            <th scope="col" className="mc-heat-rh">
              {rowHeading}
            </th>
            {columns.map((c) => (
              <th key={c.key} scope="col" className="n">
                {c.label}
                <span className="mc-heat-dir" title={c.direction === 'lower_is_better' ? 'Lower is better' : c.direction === 'higher_is_better' ? 'Higher is better' : 'Not ranked'}>
                  {c.direction === 'lower_is_better' ? ' ↓' : c.direction === 'higher_is_better' ? ' ↑' : ''}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={r.key}>
              <th scope="row" className="mc-heat-rh">
                <span className="l1">{r.label}</span>
                {r.sub && <span className="l2">{r.sub}</span>}
              </th>
              {columns.map((c, ci) => {
                const v = r.values[ci] ?? null;
                const b = v === null ? 'na' : c.direction === 'neutral' ? 'q3' : heatBand(ranks[ci][ri]);
                const isCur = cur[0] === ri && cur[1] === ci;
                return (
                  <td
                    key={c.key}
                    ref={(el) => {
                      if (el) refs.current.set(`${ri}:${ci}`, el);
                    }}
                    className={`n mc-heat-c mc-heat--${b}${onDrill ? ' is-link' : ''}`}
                    tabIndex={isCur ? 0 : -1}
                    aria-label={`${r.label}, ${c.label}: ${v === null ? 'not meaningful' : `${formatValue(v, c.unit)}, ${word(b)}`}`}
                    onKeyDown={(e) => onKey(e, ri, ci)}
                    onFocus={() => setCur([ri, ci])}
                    onClick={onDrill ? () => onDrill(r.key, c.key) : undefined}
                  >
                    {v === null ? 'n/m' : formatValue(v, c.unit, { compact: c.unit === 'money' })}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mc-heat-key" aria-hidden="true">
        <span>Worse</span>
        <i className="mc-heat--q1" />
        <i className="mc-heat--q2" />
        <i className="mc-heat--q3" />
        <i className="mc-heat--q4" />
        <i className="mc-heat--q5" />
        <span>Better</span>
        <i className="mc-heat--na" />
        <span>n/m</span>
      </div>
    </div>
  );
}
