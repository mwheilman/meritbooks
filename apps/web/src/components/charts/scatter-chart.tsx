'use client';

/**
 * ScatterChart — Rule of 40 (growth % × EBITDA margin %) and company leagues.
 * A reference line x + y = k (default 40%) with the passing side washed Sky;
 * square markers sized by an optional third value (revenue); labels placed
 * right of the point and dropped when they would collide. ← → walk points in
 * x order; Enter drills.
 */
import { useMemo } from 'react';
import { formatValue } from './core/format';
import { useActive, useChartCard, useContainerWidth, useRoving } from './core/hooks';
import { PlotFrame, Tooltip, YAxis } from './core/parts';
import { linearScale, textWidth, ticksForUnit, extent } from './core/scale';
import type { ChartUnit, Value } from './core/types';

export interface ScatterPoint {
  key: string;
  label: string;
  x: Value;
  y: Value;
  /** Optional size (e.g. revenue, cents). */
  size?: Value;
}

export interface ScatterChartProps {
  points: ReadonlyArray<ScatterPoint>;
  xLabel: string;
  yLabel: string;
  xUnit?: ChartUnit;
  yUnit?: ChartUnit;
  sizeUnit?: ChartUnit;
  sizeLabel?: string;
  /** Draw x + y = k (Rule of 40: 0.4). null = none. */
  sumLine?: number | null;
  sumLabel?: string;
  height?: number;
  highlight?: string;
  onDrill?: (key: string) => void;
  ariaLabel?: string;
}

const M = { top: 16, right: 16, bottom: 44 };

function isNum(v: Value | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

export function ScatterChart({
  points,
  xLabel,
  yLabel,
  xUnit = 'percent',
  yUnit = 'percent',
  sizeUnit = 'money',
  sizeLabel = 'Revenue',
  sumLine = 0.4,
  sumLabel,
  height = 300,
  highlight,
  onDrill,
  ariaLabel,
}: ScatterChartProps) {
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const { labelledBy } = useChartCard();
  const [active, setActive] = useActive();
  const valid = useMemo(() => points.filter((p) => isNum(p.x) && isNum(p.y)).sort((a, b) => (a.x as number) - (b.x as number)), [points]);

  const geo = useMemo(() => {
    const ex = extent(valid.map((p) => p.x), isNum(sumLine) ? [0, sumLine] : undefined) ?? [0, 1];
    const ey = extent(valid.map((p) => p.y), isNum(sumLine) ? [0, sumLine] : undefined) ?? [0, 1];
    const tx = ticksForUnit(ex[0], ex[1], xUnit, width < 480 ? 3 : 5, true);
    const ty = ticksForUnit(ey[0], ey[1], yUnit, 4, true);
    const left = Math.max(...ty.ticks.map((v) => textWidth(formatValue(v, yUnit, { decimals: 0 })))) + 12;
    const x = linearScale([tx.min, tx.max], [left, width - M.right]);
    const y = linearScale([ty.min, ty.max], [height - M.bottom, M.top]);
    const sizes = valid.map((p) => p.size).filter(isNum);
    const smax = sizes.length ? Math.max(...sizes) : 0;
    const side = (p: ScatterPoint) => (isNum(p.size) && smax > 0 ? 6 + Math.sqrt(Math.max(0, p.size) / smax) * 12 : 9);
    return { tx, ty, x, y, left, side };
  }, [valid, sumLine, xUnit, yUnit, width, height]);

  const { tx, ty, x, y, left, side } = geo;
  const roving = useRoving(valid.length, { initial: 0, onActivate: onDrill ? (i) => onDrill(valid[i].key) : undefined, onFocusIndex: setActive });

  // Greedy label placement: markers are obstacles first; each label tries the
  // right, then the left of its marker, and is dropped (the tooltip and table
  // still carry it) if both collide. The highlighted company is placed first.
  type Box = { x0: number; x1: number; y0: number; y1: number };
  const hits = (a: Box, b: Box) => !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1);
  const placed: Box[] = valid.map((p) => {
    const s = side(p) / 2;
    const cx = x(p.x as number);
    const cy = y(p.y as number);
    return { x0: cx - s, x1: cx + s, y0: cy - s, y1: cy + s };
  });
  // Highlight first, then leaders (highest x + y) — the names a reader needs most.
  const score = (p: ScatterPoint) => (p.x as number) + (p.y as number);
  const order = valid
    .map((_, i) => i)
    .sort((a, b) => (valid[a].key === highlight ? -1 : valid[b].key === highlight ? 1 : score(valid[b]) - score(valid[a])));
  const labelFor: Array<{ px: number; py: number; anchor: 'start' | 'end' | 'middle' } | null> = valid.map(() => null);
  for (const i of order) {
    const p = valid[i];
    const s = side(p) / 2;
    const cx = x(p.x as number);
    const cy = y(p.y as number);
    const w = textWidth(p.label);
    const own = placed[i];
    const others = placed.filter((b) => b !== own);
    const right: Box = { x0: cx + s + 4, x1: cx + s + 4 + w, y0: cy - 7, y1: cy + 7 };
    const left: Box = { x0: cx - s - 4 - w, x1: cx - s - 4, y0: cy - 7, y1: cy + 7 };
    const above: Box = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - s - 18, y1: cy - s - 4 };
    const below: Box = { x0: cx - w / 2, x1: cx + w / 2, y0: cy + s + 4, y1: cy + s + 18 };
    const fits = (b: Box) => b.x0 >= geo.left && b.x1 <= width && b.y0 >= 0 && b.y1 <= height - M.bottom && !others.some((o) => hits(b, o));
    if (fits(right)) {
      placed.push(right);
      labelFor[i] = { px: right.x0, py: cy, anchor: 'start' };
    } else if (fits(left)) {
      placed.push(left);
      labelFor[i] = { px: left.x1, py: cy, anchor: 'end' };
    } else if (fits(above)) {
      placed.push(above);
      labelFor[i] = { px: cx, py: (above.y0 + above.y1) / 2, anchor: 'middle' };
    } else if (fits(below)) {
      placed.push(below);
      labelFor[i] = { px: cx, py: (below.y0 + below.y1) / 2, anchor: 'middle' };
    }
  }

  // The pass region above x + y = k, clipped to the plot.
  let passPath = '';
  let line: { x1: number; y1: number; x2: number; y2: number } | null = null;
  if (isNum(sumLine)) {
    const k = sumLine;
    const xa = tx.min;
    const xb = tx.max;
    // Clip the line to the plot: where it enters (top or left) and exits (bottom or right).
    const xAtYmax = k - ty.max;
    const xAtYmin = k - ty.min;
    const xs = Math.max(xa, Math.min(xb, xAtYmax));
    const xe = Math.max(xa, Math.min(xb, xAtYmin));
    line = { x1: x(xs), y1: y(k - xs), x2: x(xe), y2: y(k - xe) };
    passPath = `M${x(xs)},${y(ty.max)}L${line.x1},${line.y1}L${line.x2},${line.y2}L${x(xb)},${y(Math.max(ty.min, k - xb))}L${x(xb)},${y(ty.max)}Z`;
  }

  const a = active !== null ? valid[active] : null;
  const tip = a ? (
    <Tooltip
      x={x(a.x as number)}
      y={y(a.y as number) - 28}
      width={width}
      title={a.label}
      rows={[
        { label: xLabel, value: formatValue(a.x, xUnit) },
        { label: yLabel, value: formatValue(a.y, yUnit) },
        ...(isNum(sumLine) ? [{ label: sumLabel ?? `Score (rule of ${Math.round(sumLine * 100)})`, value: String(Math.round(((a.x as number) + (a.y as number)) * 100)), strong: true, tone: ((a.x as number) + (a.y as number) >= sumLine ? 'pos' : 'neg') as 'pos' | 'neg' }] : []),
        ...(isNum(a.size) ? [{ label: sizeLabel, value: formatValue(a.size, sizeUnit, { compact: true }) }] : []),
      ]}
    />
  ) : null;

  return (
    <PlotFrame frameRef={ref} width={width} height={height} labelledBy={labelledBy} label={ariaLabel} overlay={tip} onPointerLeave={() => setActive(null)} className={onDrill ? 'is-drillable' : undefined}>
      {passPath && <path className="mc-pass" d={passPath} aria-hidden="true" />}
      <YAxis ticks={ty.ticks} y={y} unit={yUnit} x0={left} x1={width - M.right} labelX={left - 8} />
      <g aria-hidden="true">
        {tx.ticks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? 'mc-zero' : 'mc-grid mc-grid--v'} x1={x(v)} x2={x(v)} y1={M.top} y2={height - M.bottom} />
            <text className="mc-tick" x={x(v)} y={height - M.bottom + 16} textAnchor="middle">
              {formatValue(v, xUnit, { decimals: 0 })}
            </text>
          </g>
        ))}
        <text className="mc-tick mc-tick--axis" x={width - M.right} y={height - 8} textAnchor="end">
          {xLabel} →
        </text>
        <text className="mc-tick mc-tick--axis" x={left + 4} y={M.top + 4} dy="0.6em">
          ↑ {yLabel}
        </text>
        {line && (
          <>
            <line className="mc-refline" x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} />
            <text className="mc-reflbl" x={(line.x1 + line.x2) / 2 + 6} y={(line.y1 + line.y2) / 2 - 8} textAnchor="start">
              {sumLabel ?? `Rule of ${Math.round((sumLine ?? 0) * 100)}`}
            </text>
          </>
        )}
      </g>
      {valid.map((p, i) => {
        const s = side(p) + (i === active ? 3 : 0);
        const cx = x(p.x as number);
        const cy = y(p.y as number);
        const pass = isNum(sumLine) ? (p.x as number) + (p.y as number) >= sumLine : true;
        const lab = labelFor[i];
        return (
          <g
            key={p.key}
            className="mc-pt"
            role={onDrill ? 'button' : 'img'}
            aria-label={`${p.label}: ${xLabel.toLowerCase()} ${formatValue(p.x, xUnit)}, ${yLabel.toLowerCase()} ${formatValue(p.y, yUnit)}${isNum(sumLine) ? `, score ${Math.round(((p.x as number) + (p.y as number)) * 100)}${pass ? ', passes' : ', below the line'}` : ''}`}
            {...roving.getProps(i)}
            onPointerEnter={() => setActive(i)}
          >
            <rect className={`mc-dot${pass ? '' : ' mc-dot--fail'}${p.key === highlight ? ' is-hl' : ''}${i === active ? ' is-on' : ''}`} x={cx - s / 2} y={cy - s / 2} width={s} height={s} />
            {lab && (
              <text className={`mc-dot-lbl${p.key === highlight ? ' is-hl' : ''}`} x={lab.px} y={lab.py} dy="0.32em" textAnchor={lab.anchor}>
                {p.label}
              </text>
            )}
          </g>
        );
      })}
    </PlotFrame>
  );
}
