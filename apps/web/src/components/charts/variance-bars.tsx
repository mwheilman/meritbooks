'use client';

/**
 * VarianceBars — actual vs plan per line, drawn as IMPACT: favourable to the
 * right in solid Electric, unfavourable to the left hatched brick. Direction per
 * row (revenue: higher is better; a cost line: lower is better) decides F/U, so
 * a cost overrun and a revenue shortfall both read "left, hatched, U".
 */
import { useMemo } from 'react';
import { formatValue, fuLabel } from './core/format';
import { useActive, useChartCard, useContainerWidth, useRoving, useSvgId } from './core/hooks';
import { ChartDefs, fillUrl, PlotFrame, Tooltip, fillStyle } from './core/parts';
import { linearScale, textWidth, ticksForUnit, bandScale } from './core/scale';
import { variance } from './core/series';
import type { ChartTable } from './core/table';
import type { ChartUnit, MetricDirection, Value } from './core/types';

export interface VarianceRow {
  key: string;
  label: string;
  actual: Value;
  plan: Value;
  direction: MetricDirection;
}

export interface VarianceBarsProps {
  rows: ReadonlyArray<VarianceRow>;
  unit: ChartUnit;
  /** "Budget", "Prior year", "Forecast". */
  planLabel?: string;
  /** Sort by absolute impact (default true). */
  sort?: boolean;
  onDrill?: (rowKey: string) => void;
  ariaLabel?: string;
}

function isNum(v: Value | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

interface Computed {
  row: VarianceRow;
  delta: number | null;
  rel: number | null;
  favourable: boolean | null;
  /** Signed impact: + favourable, − unfavourable. */
  impact: number | null;
}

export function computeVariances(rows: ReadonlyArray<VarianceRow>, sort = true): Computed[] {
  const out = rows.map((row) => {
    if (!isNum(row.actual) || !isNum(row.plan)) return { row, delta: null, rel: null, favourable: null, impact: null };
    const v = variance(row.actual, row.plan, row.direction);
    const impact = v.favourable === null ? v.delta : v.favourable ? Math.abs(v.delta) : -Math.abs(v.delta);
    return { row, delta: v.delta, rel: v.rel, favourable: v.favourable, impact };
  });
  return sort ? [...out].sort((a, b) => Math.abs(b.impact ?? 0) - Math.abs(a.impact ?? 0)) : out;
}

/** Line · Actual · Plan · Variance · % · F/U — the table behind VarianceBars. */
export function varianceTable(rows: ReadonlyArray<VarianceRow>, opts: { caption: string; unit: ChartUnit; planLabel?: string; sort?: boolean }): ChartTable {
  const c = computeVariances(rows, opts.sort ?? true);
  return {
    caption: opts.caption,
    columns: [
      { key: 'line', label: 'Line' },
      { key: 'actual', label: 'Actual', unit: opts.unit },
      { key: 'plan', label: opts.planLabel ?? 'Budget', unit: opts.unit },
      { key: 'variance', label: 'Variance', unit: opts.unit },
      { key: 'pct', label: 'Variance %', unit: 'percent' },
      { key: 'fu', label: 'F/U' },
    ],
    rows: c.map((x) => ({ key: x.row.key, cells: [x.row.label, x.row.actual, x.row.plan, x.delta, x.rel, fuLabel(x.favourable)] })),
  };
}

export function VarianceBars({ rows, unit, planLabel = 'Budget', sort = true, onDrill, ariaLabel }: VarianceBarsProps) {
  const id = useSvgId('vb');
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const { labelledBy } = useChartCard();
  const [active, setActive] = useActive();
  const items = useMemo(() => computeVariances(rows, sort), [rows, sort]);
  const height = Math.max(140, items.length * 32 + 56);

  const geo = useMemo(() => {
    const impacts = items.map((i) => i.impact).filter(isNum);
    const maxAbs = Math.max(1, ...impacts.map(Math.abs));
    const t = ticksForUnit(-maxAbs, maxAbs, unit, width < 480 ? 2 : 4, true);
    const labelW = Math.min(Math.round(width * 0.34), Math.max(...items.map((i) => textWidth(i.row.label, 13))) + 16);
    const x = linearScale([t.min, t.max], [labelW + 56, width - 72]);
    const band = bandScale(items.length, [24, height - 28], 0.34, 0.05);
    return { t, x, band, labelW };
  }, [items, unit, width, height]);

  const roving = useRoving(items.length, { initial: 0, onActivate: onDrill ? (i) => onDrill(items[i].row.key) : undefined, onFocusIndex: setActive });
  const { x, band, labelW, t } = geo;

  const label = (c: Computed) =>
    `${c.row.label}: actual ${formatValue(c.row.actual, unit)}, ${planLabel.toLowerCase()} ${formatValue(c.row.plan, unit)}, ` +
    (c.delta === null ? 'variance not available' : `variance ${formatValue(c.delta, unit, { delta: true })}${c.favourable === null ? '' : c.favourable ? ', favourable' : ', unfavourable'}`);

  const a = active !== null ? items[active] : null;
  const tip = a ? (
    <Tooltip
      x={x(a.impact ?? 0)}
      y={band.x(active ?? 0) - 8}
      width={width}
      title={a.row.label}
      rows={[
        { label: 'Actual', value: formatValue(a.row.actual, unit), strong: true },
        { label: planLabel, value: formatValue(a.row.plan, unit), swatch: 'tick' },
        { label: 'Variance', value: a.delta === null ? 'n/a' : `${formatValue(a.delta, unit, { delta: true })} ${fuLabel(a.favourable)}`, tone: a.favourable === null ? 'muted' : a.favourable ? 'pos' : 'neg' },
        ...(a.rel !== null ? [{ label: 'Variance %', value: formatValue(a.rel, 'percent', { delta: true }) }] : []),
      ]}
    />
  ) : null;

  return (
    <PlotFrame frameRef={ref} width={width} height={height} labelledBy={labelledBy} label={ariaLabel} overlay={tip} onPointerLeave={() => setActive(null)} className={onDrill ? 'is-drillable' : undefined}>
      <ChartDefs id={id} />
      <g aria-hidden="true">
        {t.ticks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? 'mc-zero' : 'mc-grid'} x1={x(v)} x2={x(v)} y1={20} y2={height - 24} />
            <text className="mc-tick" x={x(v)} y={height - 8} textAnchor="middle">
              {v === 0 ? '0' : formatValue(Math.abs(v), unit, { compact: true })}
            </text>
          </g>
        ))}
        <text className="mc-tick mc-tick--axis" x={x(0) - 8} y={12} textAnchor="end">
          ← Unfavourable
        </text>
        <text className="mc-tick mc-tick--axis" x={x(0) + 8} y={12} textAnchor="start">
          Favourable →
        </text>
      </g>
      {items.map((c, i) => {
        const y0 = band.x(i);
        const h = band.bandwidth;
        const imp = c.impact;
        return (
          <g key={c.row.key} aria-hidden="true">
            <text className="mc-cat" x={0} y={band.mid(i)} dy="0.32em">
              {c.row.label}
            </text>
            <text className="mc-cat-v" x={labelW + 48} y={band.mid(i)} dy="0.32em" textAnchor="end">
              {formatValue(c.row.actual, unit, { compact: true })}
            </text>
            {isNum(imp) ? (
              <>
                <rect
                  className={`mc-rect ${c.favourable === false ? 'mc-bar--neg' : c.favourable === null ? 'mc-s3' : 'mc-s0'}${i === active ? ' is-on' : ''}`}
                  x={Math.min(x(0), x(imp))}
                  y={y0}
                  width={Math.max(1, Math.abs(x(imp) - x(0)))}
                  height={h}
                  style={fillStyle(c.favourable === false ? fillUrl(id, 'neg') : undefined)}
                />
                <text className={`mc-vlbl ${c.favourable === false ? 'is-neg' : c.favourable ? 'is-pos' : ''}`} x={imp < 0 ? x(imp) - 6 : x(imp) + 6} y={band.mid(i)} dy="0.32em" textAnchor={imp < 0 ? 'end' : 'start'}>
                  {formatValue(c.delta ?? 0, unit, { compact: true, delta: true })}
                  {c.favourable !== null && <tspan className="mc-fu">{` ${fuLabel(c.favourable)}`}</tspan>}
                </text>
              </>
            ) : (
              <text className="mc-gaptxt" x={x(0) + 6} y={band.mid(i)} dy="0.32em">
                {isNum(c.row.plan) ? 'n/a' : `No ${planLabel.toLowerCase()}`}
              </text>
            )}
          </g>
        );
      })}
      {items.map((c, i) => (
        <g key={`h${c.row.key}`} className="mc-pt" role={onDrill ? 'button' : 'img'} aria-label={label(c)} {...roving.getProps(i)} onPointerEnter={() => setActive(i)}>
          <rect className="mc-hit" x={0} y={band.x(i) - (band.step - band.bandwidth) / 2} width={width} height={band.step} />
        </g>
      ))}
    </PlotFrame>
  );
}
