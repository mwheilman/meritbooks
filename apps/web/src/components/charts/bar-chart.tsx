'use client';

/**
 * BarChart — grouped or stacked, columns or horizontal bars. Bars start at zero;
 * negatives go below (stacks diverge from zero); a null takes no space and is
 * labelled "n/a" rather than drawn as zero. Every bar is a keyboard stop.
 * Also used for the maturity ladder (debt by year) and spend by vendor.
 */
import { useMemo } from 'react';
import { axisLabels, formatValue } from './core/format';
import { useActive, useChartCard, useContainerWidth, useHidden, useRoving, useSvgId } from './core/hooks';
import { ChartDefs, fillUrl, PlotFrame, seriesClass, SERIES_SWATCH, Tooltip, XLabels, YAxis, type TooltipRow, fillStyle } from './core/parts';
import { bandScale, labelEvery, linearScale, textWidth, ticksForUnit, extent } from './core/scale';
import { stack, stackExtent } from './core/series';
import type { Category, CategorySeries, ChartUnit, MetricDirection, Value } from './core/types';
import type { LegendItem } from './legend';

/**
 * Legend items for a BarChart's series, with the SAME palette index the bars
 * use — so a legend can never disagree with the chart. Add encodings (loss) after.
 */
export function seriesLegend(series: ReadonlyArray<{ key: string; label: string }>): LegendItem[] {
  return series.map((s, i) => ({ key: s.key, label: s.label, swatch: SERIES_SWATCH[i % SERIES_SWATCH.length] }));
}

export interface BarChartProps {
  categories: ReadonlyArray<Category>;
  series: ReadonlyArray<CategorySeries>;
  unit: ChartUnit;
  mode?: 'grouped' | 'stacked';
  orientation?: 'vertical' | 'horizontal';
  /** Loss bars (value < 0 where higher is better) are hatched brick. */
  direction?: MetricDirection;
  height?: number;
  /** Print the value on each bar (single-series / horizontal). Default: auto. */
  valueLabels?: boolean;
  hidden?: ReadonlyArray<string>;
  onDrill?: (categoryKey: string, seriesKey: string) => void;
  ariaLabel?: string;
  /** Highlight one category (e.g. "this company"). */
  highlight?: string;
}

function isNum(v: Value | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

interface BarGeom {
  ci: number;
  si: number;
  value: Value;
  /** Rect in SVG space. */
  x: number;
  y: number;
  w: number;
  h: number;
  loss: boolean;
}

export function BarChart({
  categories,
  series: allSeries,
  unit,
  mode = 'grouped',
  orientation = 'vertical',
  direction = 'neutral',
  height: heightProp,
  valueLabels,
  hidden: hiddenProp,
  onDrill,
  ariaLabel,
  highlight,
}: BarChartProps) {
  const id = useSvgId('bc');
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const isHidden = useHidden(hiddenProp);
  const { labelledBy } = useChartCard();
  const [active, setActive] = useActive();
  const series = allSeries.filter((s) => !isHidden(s.key));
  const horizontal = orientation === 'horizontal';
  const nc = categories.length;
  const rowH = mode === 'stacked' || series.length <= 1 ? 28 : 16 * series.length + 12;
  const height = heightProp ?? (horizontal ? Math.max(120, nc * rowH + 36) : 240);
  const showValues = valueLabels ?? (horizontal || (series.length === 1 && nc <= 12));

  const geo = useMemo(() => {
    const narrow = width < 480;
    const stacked = mode === 'stacked' ? stack(series.map((s) => s.values), nc) : null;
    const [lo, hi] = stacked ? stackExtent(stacked) : (extent(...series.map((s) => s.values)) ?? [0, 1]);
    const t = ticksForUnit(lo, hi, unit, narrow ? 3 : horizontal ? 5 : 4, true);
    const bars: BarGeom[] = [];
    if (horizontal) {
      const labelW = Math.min(Math.round(width * 0.36), Math.max(...categories.map((c) => textWidth(c.label, 13))) + 16);
      const valuePad = showValues ? 64 : 12;
      const x = linearScale([t.min, t.max], [labelW, width - valuePad]);
      const band = bandScale(nc, [8, height - 28], mode === 'stacked' || series.length <= 1 ? 0.36 : 0.2, 0.05);
      const sub = bandScale(Math.max(1, series.length), [0, band.bandwidth], 0.12, 0);
      categories.forEach((_, ci) => {
        series.forEach((s, si) => {
          const v = s.values[ci] ?? null;
          const loss = isNum(v) && v < 0 && direction === 'higher_is_better';
          if (stacked) {
            const c = stacked[si][ci];
            bars.push({ ci, si, value: v, x: x(Math.min(c.y0, c.y1)), y: band.x(ci), w: Math.abs(x(c.y1) - x(c.y0)), h: band.bandwidth, loss });
          } else {
            const val = isNum(v) ? v : 0;
            bars.push({ ci, si, value: v, x: x(Math.min(0, val)), y: band.x(ci) + sub.x(si), w: Math.abs(x(val) - x(0)), h: sub.bandwidth, loss });
          }
        });
      });
      return { t, x, band, bars, labelW, narrow };
    }
    const left = Math.max(...t.ticks.map((v) => textWidth(formatValue(v, unit, { compact: true })))) + 12;
    const y = linearScale([t.min, t.max], [height - 30, 16]);
    const band = bandScale(nc, [left, width - 12], nc > 12 ? 0.24 : 0.32, 0.1);
    const sub = bandScale(Math.max(1, series.length), [0, band.bandwidth], 0.08, 0);
    categories.forEach((_, ci) => {
      series.forEach((s, si) => {
        const v = s.values[ci] ?? null;
        const loss = isNum(v) && v < 0 && direction === 'higher_is_better';
        if (stacked) {
          const c = stacked[si][ci];
          bars.push({ ci, si, value: v, x: band.x(ci), y: y(Math.max(c.y0, c.y1)), w: band.bandwidth, h: Math.abs(y(c.y0) - y(c.y1)), loss });
        } else {
          const val = isNum(v) ? v : 0;
          bars.push({ ci, si, value: v, x: band.x(ci) + sub.x(si), y: y(Math.max(0, val)), w: sub.bandwidth, h: Math.abs(y(val) - y(0)), loss });
        }
      });
    });
    return { t, y, band, bars, left, narrow, every: labelEvery(nc, width - left - 12, 56, categories.map((c) => c.label)) };
  }, [width, mode, series, nc, unit, horizontal, categories, showValues, height, direction]);

  const focusBars = geo.bars;
  const roving = useRoving(focusBars.length, {
    initial: 0,
    onActivate: onDrill ? (i) => onDrill(categories[focusBars[i].ci].key, series[focusBars[i].si].key) : undefined,
    onFocusIndex: setActive,
  });

  const activeBar = active !== null ? focusBars[active] : null;
  const tipRows = (ci: number): TooltipRow[] => {
    const rows: TooltipRow[] = series.map((s, si) => ({ label: s.label, value: isNum(s.values[ci]) ? formatValue(s.values[ci], unit) : 'n/a', swatch: SERIES_SWATCH[allSeries.indexOf(s) % SERIES_SWATCH.length], strong: activeBar?.si === si }));
    if (mode === 'stacked' && series.length > 1) {
      const vals = series.map((s) => s.values[ci]).filter(isNum);
      rows.push({ label: 'Total', value: formatValue(vals.reduce((a, b) => a + b, 0), unit), strong: true });
    }
    return rows;
  };

  const barLabel = (b: BarGeom) => `${categories[b.ci].label}${series.length > 1 ? `, ${series[b.si].label}` : ''}: ${isNum(b.value) ? formatValue(b.value, unit) : 'not available'}`;

  const tip = activeBar ? (
    <Tooltip
      x={horizontal ? activeBar.x + activeBar.w : activeBar.x + activeBar.w / 2}
      y={horizontal ? activeBar.y - 8 : activeBar.y - 24}
      width={width}
      title={categories[activeBar.ci].label}
      rows={tipRows(activeBar.ci)}
    />
  ) : null;

  return (
    <PlotFrame frameRef={ref} width={width} height={height} labelledBy={labelledBy} label={ariaLabel} overlay={tip} onPointerLeave={() => setActive(null)} className={onDrill ? 'is-drillable' : undefined}>
      <ChartDefs id={id} />
      {horizontal && 'x' in geo && geo.x ? (
        <g aria-hidden="true">
          {geo.t.ticks.map((v, k) => (
            <g key={v}>
              <line className={v === 0 ? 'mc-zero' : 'mc-grid'} x1={geo.x(v)} x2={geo.x(v)} y1={4} y2={height - 24} />
              <text className="mc-tick" x={geo.x(v)} y={height - 8} textAnchor="middle">
                {axisLabels(geo.t.ticks, unit)[k]}
              </text>
            </g>
          ))}
          {categories.map((c, ci) => (
            <text key={c.key} className={`mc-cat${c.key === highlight ? ' is-hl' : ''}`} x={0} y={geo.band.mid(ci)} dy="0.32em">
              {c.label.length > 28 && geo.narrow ? `${c.label.slice(0, 26)}…` : c.label}
            </text>
          ))}
        </g>
      ) : (
        'y' in geo && geo.y && <YAxis ticks={geo.t.ticks} y={geo.y} unit={unit} x0={geo.left} x1={width - 12} labelX={geo.left - 8} />
      )}

      {focusBars.map((b, i) => {
        const s = series[b.si];
        const sIdx = allSeries.indexOf(s);
        if (!isNum(b.value)) {
          return (
            <text key={i} className="mc-gaptxt" x={horizontal ? b.x + 4 : b.x + b.w / 2} y={horizontal ? b.y + b.h / 2 : b.y - 4} dy={horizontal ? '0.32em' : undefined} textAnchor={horizontal ? 'start' : 'middle'} aria-hidden="true">
              n/a
            </text>
          );
        }
        const hl = highlight && categories[b.ci].key === highlight;
        return (
          <rect
            key={i}
            className={`mc-rect ${b.loss ? 'mc-bar--neg' : seriesClass(sIdx)}${i === active ? ' is-on' : ''}${hl ? ' is-hl' : ''}`}
            x={b.x}
            y={b.y}
            width={Math.max(1, b.w)}
            height={Math.max(1, b.h)}
            style={fillStyle(b.loss ? fillUrl(id, 'neg') : undefined)}
          />
        );
      })}

      {showValues &&
        focusBars.map((b, i) => {
          if (!isNum(b.value) || (mode === 'stacked' && b.si !== series.length - 1)) return null;
          const v = mode === 'stacked' ? stackTotal(series, b.ci) : b.value;
          let lx = b.x + b.w / 2;
          let ly = v < 0 ? b.y + b.h + 14 : b.y - 6;
          let anchor: 'start' | 'middle' | 'end' = 'middle';
          if (horizontal) {
            const end = mode === 'stacked' && 'x' in geo && geo.x ? geo.x(Math.max(0, v)) : b.x + b.w;
            lx = v < 0 && mode !== 'stacked' ? b.x - 6 : end + 6;
            ly = b.y + b.h / 2;
            anchor = v < 0 && mode !== 'stacked' ? 'end' : 'start';
          }
          return (
            <text key={`v${i}`} className="mc-vlbl" x={lx} y={ly} dy={horizontal ? '0.32em' : undefined} textAnchor={anchor} aria-hidden="true">
              {formatValue(v, unit, { compact: true })}
            </text>
          );
        })}

      {!horizontal && 'every' in geo && (
        <XLabels labels={categories.map((c) => c.label)} x={(i) => geo.band.mid(i)} y={height - 12} every={geo.every ?? 1} current={activeBar?.ci} />
      )}

      {focusBars.map((b, i) => (
        <g key={`h${i}`} className="mc-pt" role={onDrill ? 'button' : 'img'} aria-label={barLabel(b)} {...roving.getProps(i)} onPointerEnter={() => setActive(i)}>
          <rect className="mc-hit" x={horizontal ? 0 : b.x} y={horizontal ? b.y : 8} width={horizontal ? width : Math.max(4, b.w)} height={horizontal ? Math.max(4, b.h) : height - 38} />
        </g>
      ))}
    </PlotFrame>
  );
}

function stackTotal(series: ReadonlyArray<CategorySeries>, ci: number): number {
  return series.reduce((s, x) => s + (isNum(x.values[ci]) ? (x.values[ci] as number) : 0), 0);
}
