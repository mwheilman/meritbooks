'use client';

/**
 * AgingBars — AR / AP aging by customer, vendor or company: one stacked bar per
 * row across the buckets, in amounts (comparable across rows) or as a 100%
 * mix. Severity ramps Electric → Blue-200 → ochre → hatched brick for the
 * oldest bucket, so "how much is late" reads without colour. Each segment is a
 * drill target (row × bucket → the open items).
 */
import { useMemo } from 'react';
import { formatValue } from './core/format';
import { useActive, useChartCard, useContainerWidth, useRoving, useSvgId } from './core/hooks';
import { ChartDefs, fillUrl, PlotFrame, Tooltip, type SwatchKind, fillStyle } from './core/parts';
import { bandScale, linearScale, textWidth, ticksForUnit } from './core/scale';
import type { ChartTable } from './core/table';
import type { Value } from './core/types';

export interface AgingBucket {
  key: string;
  label: string;
}

export interface AgingRow {
  key: string;
  label: string;
  sub?: string;
  values: Value[];
}

export interface AgingBarsProps {
  buckets: ReadonlyArray<AgingBucket>;
  rows: ReadonlyArray<AgingRow>;
  mode?: 'amount' | 'percent';
  /** Prepend an "All" total row. Default true. */
  totalRow?: boolean;
  totalLabel?: string;
  onDrill?: (rowKey: string, bucketKey: string) => void;
  ariaLabel?: string;
}

/** Severity class per bucket index (last = oldest). */
export function bucketClass(j: number, n: number): string {
  if (j === n - 1 && n > 1) return 'mc-ag-4';
  if (j === n - 2 && n > 2) return 'mc-ag-3';
  if (j === 0) return 'mc-ag-0';
  return j === 1 ? 'mc-ag-1' : 'mc-ag-2';
}
export function bucketSwatch(j: number, n: number): SwatchKind {
  const c = bucketClass(j, n);
  return c === 'mc-ag-4' ? 'neg' : c === 'mc-ag-3' ? 'warn' : c === 'mc-ag-0' ? 'solid' : c === 'mc-ag-1' ? 'solid-2' : 'solid-4';
}

function isNum(v: Value | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

function withTotal(rows: ReadonlyArray<AgingRow>, n: number, label: string): AgingRow {
  return { key: '__all', label, values: Array.from({ length: n }, (_, j) => rows.reduce((s, r) => s + (isNum(r.values[j]) ? (r.values[j] as number) : 0), 0)) };
}

export function agingTable(buckets: ReadonlyArray<AgingBucket>, rows: ReadonlyArray<AgingRow>, caption: string, rowHeading = 'Customer', totalLabel = 'All'): ChartTable {
  const all = withTotal(rows, buckets.length, totalLabel);
  const sum = (r: AgingRow) => r.values.reduce<number>((s, v) => s + (isNum(v) ? v : 0), 0);
  return {
    caption,
    columns: [{ key: 'row', label: rowHeading }, ...buckets.map((b) => ({ key: b.key, label: b.label, unit: 'money' as const })), { key: 'total', label: 'Total', unit: 'money' }],
    rows: [
      ...rows.map((r) => ({ key: r.key, cells: [r.label, ...buckets.map((_, j) => r.values[j] ?? null), sum(r)] })),
      { key: all.key, emphasis: 'total' as const, cells: [all.label, ...all.values, sum(all)] },
    ],
  };
}

export function AgingBars({ buckets, rows: rowsIn, mode = 'amount', totalRow = true, totalLabel = 'All', onDrill, ariaLabel }: AgingBarsProps) {
  const id = useSvgId('ag');
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const { labelledBy } = useChartCard();
  const [active, setActive] = useActive();
  const nb = buckets.length;
  const rows = useMemo(() => (totalRow ? [withTotal(rowsIn, nb, totalLabel), ...rowsIn] : [...rowsIn]), [rowsIn, nb, totalRow, totalLabel]);
  const totals = rows.map((r) => r.values.reduce<number>((s, v) => s + (isNum(v) ? Math.max(0, v) : 0), 0));
  const height = rows.length * 36 + (mode === 'amount' ? 32 : 12);

  const geo = useMemo(() => {
    const labelW = Math.min(Math.round(width * 0.32), Math.max(...rows.map((r) => textWidth(r.label, 13))) + 16);
    const maxT = Math.max(1, ...totals.slice(totalRow ? 1 : 0), totalRow && rows.length === 1 ? totals[0] : 0);
    const t = ticksForUnit(0, maxT, 'money', width < 480 ? 2 : 4, true);
    const x = linearScale([0, mode === 'percent' ? 1 : t.max], [labelW, width - 64]);
    const band = bandScale(rows.length, [4, height - (mode === 'amount' ? 28 : 8)], 0.36, 0.02);
    return { labelW, t, x, band };
  }, [rows, totals, totalRow, width, mode, height]);

  const { x, band, t } = geo;
  // The "All" row is a 100% mix across the full width (it would dwarf every
  // other row in amounts); the other rows share one amount scale (comparable).
  const segs = rows.flatMap((r, ri) => {
    const isAll = totalRow && ri === 0;
    const proportional = mode === 'percent' || isAll;
    const denom = proportional ? totals[ri] || 1 : 1;
    const sx = linearScale([0, proportional ? 1 : t.max], [geo.labelW, width - 64]);
    let acc = 0;
    return buckets.map((_, j) => {
      const v = isNum(r.values[j]) ? Math.max(0, r.values[j] as number) : 0;
      const from = acc / denom;
      acc += v;
      return { ri, j, v, x0: sx(from), x1: sx(acc / denom) };
    });
  });

  const roving = useRoving(segs.length, { initial: 0, onActivate: onDrill ? (i) => onDrill(rows[segs[i].ri].key, buckets[segs[i].j].key) : undefined, onFocusIndex: setActive });
  const a = active !== null ? segs[active] : null;
  const tip = a ? (
    <Tooltip
      x={a.x1}
      y={band.x(a.ri) - 8}
      width={width}
      title={rows[a.ri].label}
      rows={[
        ...buckets.map((b, j) => ({ label: b.label, value: formatValue(rows[a.ri].values[j] ?? null, 'money'), swatch: bucketSwatch(j, nb), strong: j === a.j })),
        { label: 'Total', value: formatValue(totals[a.ri], 'money'), strong: true },
      ]}
    />
  ) : null;

  return (
    <PlotFrame frameRef={ref} width={width} height={height} labelledBy={labelledBy} label={ariaLabel} overlay={tip} onPointerLeave={() => setActive(null)} className={onDrill ? 'is-drillable' : undefined}>
      <ChartDefs id={id} />
      {mode === 'amount' && (
        <g aria-hidden="true">
          {t.ticks.map((v) => (
            <g key={v}>
              <line className={v === 0 ? 'mc-zero' : 'mc-grid'} x1={x(v)} x2={x(v)} y1={totalRow ? band.x(1) - 4 : 0} y2={height - 24} />
              <text className="mc-tick" x={x(v)} y={height - 8} textAnchor="middle">
                {formatValue(v, 'money', { compact: true })}
              </text>
            </g>
          ))}
        </g>
      )}
      {rows.map((r, ri) => (
        <g key={r.key} aria-hidden="true">
          <text className={`mc-cat${ri === 0 && totalRow ? ' is-anchor' : ''}`} x={0} y={band.mid(ri)} dy="0.32em">
            {r.label}
          </text>
          <text className={`mc-vlbl${ri === 0 && totalRow ? ' is-anchor' : ''}`} x={width} y={band.mid(ri)} dy="0.32em" textAnchor="end">
            {formatValue(totals[ri], 'money', { compact: true })}
          </text>
        </g>
      ))}
      {totalRow && <line className="mc-rule" x1={0} x2={width} y1={band.x(1) - (band.step - band.bandwidth) / 2} y2={band.x(1) - (band.step - band.bandwidth) / 2} aria-hidden="true" />}
      {segs.map((s, i) =>
        s.v > 0 ? (
          <rect
            key={i}
            className={`mc-rect ${bucketClass(s.j, nb)}${i === active ? ' is-on' : ''}`}
            x={s.x0}
            y={band.x(s.ri)}
            width={Math.max(1, s.x1 - s.x0 - 1)}
            height={band.bandwidth}
            style={fillStyle(bucketClass(s.j, nb) === 'mc-ag-4' ? fillUrl(id, 'neg') : bucketClass(s.j, nb) === 'mc-ag-3' ? fillUrl(id, 'warn') : undefined)}
          />
        ) : null,
      )}
      {/* the All row is a mix: label its segments in percent so it can't be read as dollars */}
      {totalRow &&
        segs.map((s, i) =>
          s.ri === 0 && s.v > 0 && s.x1 - s.x0 >= 40 ? (
            <text key={`p${i}`} className="mc-seglbl" x={(s.x0 + s.x1) / 2} y={band.mid(0)} dy="0.32em" textAnchor="middle" aria-hidden="true">
              {formatValue(s.v / (totals[0] || 1), 'percent', { decimals: 0 })}
            </text>
          ) : null,
        )}
      {segs.map((s, i) => (
        <g
          key={`h${i}`}
          className="mc-pt"
          role={onDrill ? 'button' : 'img'}
          aria-label={`${rows[s.ri].label}, ${buckets[s.j].label}: ${formatValue(s.v, 'money')}${totals[s.ri] > 0 ? `, ${formatValue(s.v / totals[s.ri], 'percent')} of ${formatValue(totals[s.ri], 'money', { compact: true })}` : ''}`}
          {...roving.getProps(i)}
          onPointerEnter={() => setActive(i)}
        >
          <rect className="mc-hit" x={s.x0} y={band.x(s.ri)} width={Math.max(2, s.x1 - s.x0)} height={band.bandwidth} />
        </g>
      ))}
    </PlotFrame>
  );
}

/** Bucket legend items for the ChartCard. */
export function agingLegend(buckets: ReadonlyArray<AgingBucket>) {
  return buckets.map((b, j) => ({ key: b.key, label: b.label, swatch: bucketSwatch(j, buckets.length), toggle: false }));
}

