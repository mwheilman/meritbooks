'use client';

/**
 * TimeSeriesChart — line / area / fan.
 *
 * Encodings (FEATURE-GAP-AUDIT §4.4):
 *   actual            Electric Blue, 2px, square markers
 *   prior year        dashed Midnight
 *   budget            tick marks (never a line — a budget is a target per period)
 *   preliminary       the period's column hatched behind the data
 *   forecast          dotted Electric line, hollow markers (distinct from preliminary)
 *   forecast band     Blue-100 range (fan chart)
 *   missing month     a GAP: the line breaks, a dotted hairline marks it, never zero
 * Crosshair + tooltip on hover/focus; ← → walk periods; Enter drills.
 */
import { useMemo } from 'react';
import { formatValue } from './core/format';
import { useActive, useChartCard, useContainerWidth, useHidden, useRoving, useSvgId } from './core/hooks';
import { ChartDefs, fillUrl, PlotFrame, Tooltip, XLabels, YAxis, fillStyle } from './core/parts';
import { labelEvery, linearScale, pointScale, textWidth, ticksForUnit } from './core/scale';
import { segments, lastIndex } from './core/series';
import { timeExtent, timePointLabel, timeTooltipRows, statusWord, yearMarks, type SeriesLabels } from './core/time';
import { longLabel, periodStatus, type ChartUnit, type MetricDirection, type TimeSeriesData, type Value } from './core/types';

export interface TimeSeriesChartProps {
  data: TimeSeriesData;
  unit: ChartUnit;
  direction: MetricDirection;
  /** line (default) · area (zero-based) · fan (forecast band emphasised). */
  variant?: 'line' | 'area' | 'fan';
  height?: number;
  /** Force a zero baseline (default: area → yes, line → no). */
  zero?: boolean;
  labels?: SeriesLabels;
  /** Series keys to hide (in addition to the card legend). */
  hidden?: ReadonlyArray<string>;
  /** Period click / Enter → the period key. */
  onDrill?: (periodKey: string) => void;
  /** Accessible name when used outside a ChartCard. */
  ariaLabel?: string;
  /** Label the latest value at the line end. Default true. */
  endLabel?: boolean;
}

const M = { top: 12, right: 12, bottom: 30 };

function isNum(v: Value | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

function linePath(values: ReadonlyArray<Value>, x: (i: number) => number, y: (v: number) => number, from: number, to: number): string {
  let d = '';
  for (let i = from; i <= to; i++) {
    const v = values[i];
    if (!isNum(v)) continue;
    d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  }
  return d;
}

export function TimeSeriesChart({
  data,
  unit,
  direction,
  variant = 'line',
  height = 240,
  zero,
  labels,
  hidden: hiddenProp,
  onDrill,
  ariaLabel,
  endLabel = true,
}: TimeSeriesChartProps) {
  const id = useSvgId('ts');
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const isHidden = useHidden(hiddenProp);
  const { labelledBy } = useChartCard();
  const [active, setActive] = useActive();
  const n = data.periods.length;

  const geo = useMemo(() => {
    const narrow = width < 480;
    const [lo, hi] = timeExtent(data, isHidden);
    const t = ticksForUnit(lo, hi, unit, narrow ? 3 : height < 200 ? 3 : 4, zero ?? variant === 'area');
    const left = Math.max(...t.ticks.map((v) => textWidth(formatValue(v, unit, { compact: true })))) + 12;
    const x = pointScale(n, [left, width - M.right], 1);
    const y = linearScale([t.min, t.max], [height - M.bottom, M.top]);
    return { t, x, y, left, every: labelEvery(n, width - left - M.right, narrow ? 44 : 34, data.periods.map((p) => p.label)), narrow };
  }, [data, isHidden, unit, height, zero, variant, width, n]);

  const { t, x, y, left, every } = geo;
  const plotBottom = height - M.bottom;

  // Split actual into the booked part and the forecast part (dotted).
  const firstFc = data.periods.findIndex((p) => periodStatus(p) === 'forecast');
  const bookedEnd = firstFc < 0 ? n - 1 : firstFc - 1;
  const bookedSegs = segments(data.actual.slice(0, bookedEnd + 1));
  const fcFrom = firstFc < 0 ? -1 : Math.max(0, lastIndex(data.actual.slice(0, firstFc)) >= 0 ? lastIndex(data.actual.slice(0, firstFc)) : firstFc);
  const last = lastIndex(data.actual);

  const roving = useRoving(n, {
    onActivate: onDrill ? (i) => onDrill(data.periods[i].key) : undefined,
    onFocusIndex: setActive,
    isFocusable: () => true,
  });

  const bw = Math.min(16, x.step * 0.5);
  const showMarkers = n <= 26 && x.step >= 10;

  const tip =
    active !== null && active >= 0 && active < n ? (
      <Tooltip
        x={x.mid(active)}
        y={isNum(data.actual[active]) ? y(data.actual[active] as number) - 24 : M.top}
        width={width}
        title={longLabel(data.periods[active])}
        status={statusWord(data, active)}
        rows={timeTooltipRows(data, active, unit, direction, labels, isHidden)}
      />
    ) : null;

  return (
    <PlotFrame
      frameRef={ref}
      width={width}
      height={height}
      labelledBy={labelledBy}
      label={ariaLabel}
      overlay={tip}
      onPointerLeave={() => setActive(null)}
      className={onDrill ? 'is-drillable' : undefined}
    >
      <ChartDefs id={id} />
      {/* preliminary columns, behind everything */}
      {data.periods.map((p, i) =>
        periodStatus(p) === 'preliminary' ? (
          <rect key={`pc${i}`} className="mc-prelim-col" x={x.mid(i) - x.step / 2} y={M.top} width={x.step} height={plotBottom - M.top} style={fillStyle(fillUrl(id, 'col'))} />
        ) : null,
      )}
      <YAxis ticks={t.ticks} y={y} unit={unit} x0={left} x1={width - M.right} labelX={left - 8} />

      {/* gaps: a dotted hairline where a month is missing */}
      {data.actual.map((v, i) =>
        !isNum(v) && periodStatus(data.periods[i]) !== 'forecast' ? <line key={`g${i}`} className="mc-gapline" x1={x.mid(i)} x2={x.mid(i)} y1={M.top} y2={plotBottom} /> : null,
      )}

      {/* forecast band */}
      {data.band && !isHidden('band') &&
        segments(data.band.lo.map((v, i) => (isNum(v) && isNum(data.band?.hi[i]) ? v : null))).map((s, k) => {
          const top = linePath(data.band?.hi ?? [], x.mid, y, s.start, s.end);
          const bot: string[] = [];
          for (let i = s.end; i >= s.start; i--) bot.push(`L${x.mid(i).toFixed(1)},${y(data.band?.lo[i] as number).toFixed(1)}`);
          return <path key={`b${k}`} className={variant === 'fan' ? 'mc-band mc-band--fan' : 'mc-band'} d={`${top}${bot.join('')}Z`} />;
        })}

      {/* area under the booked actual */}
      {variant === 'area' &&
        bookedSegs.map((s, k) => {
          const d = linePath(data.actual, x.mid, y, s.start, s.end);
          const base = y(Math.max(t.min, Math.min(0, t.max)));
          return <path key={`a${k}`} className="mc-area" d={`${d}L${x.mid(s.end).toFixed(1)},${base.toFixed(1)}L${x.mid(s.start).toFixed(1)},${base.toFixed(1)}Z`} />;
        })}

      {/* prior year — dashed Midnight */}
      {data.priorYear && !isHidden('priorYear') &&
        segments(data.priorYear).map((s, k) => <path key={`py${k}`} className="mc-py" d={linePath(data.priorYear ?? [], x.mid, y, s.start, s.end)} />)}

      {/* budget — tick marks */}
      {data.budget && !isHidden('budget') &&
        data.budget.map((b, i) => (isNum(b) ? <line key={`bt${i}`} className="mc-bud" x1={x.mid(i) - bw / 2} x2={x.mid(i) + bw / 2} y1={y(b)} y2={y(b)} /> : null))}

      {/* actual — booked solid, forecast dotted */}
      {!isHidden('actual') && bookedSegs.map((s, k) => <path key={`l${k}`} className="mc-line" d={linePath(data.actual, x.mid, y, s.start, s.end)} />)}
      {!isHidden('actual') && firstFc >= 0 && <path className="mc-line mc-line--fc" d={linePath(data.actual, x.mid, y, fcFrom, n - 1)} />}

      {/* crosshair */}
      {active !== null && <line className="mc-cross" x1={x.mid(active)} x2={x.mid(active)} y1={M.top} y2={plotBottom} />}

      {/* markers */}
      {!isHidden('actual') &&
        data.actual.map((v, i) => {
          if (!isNum(v)) return null;
          const st = periodStatus(data.periods[i]);
          const big = i === active || i === last;
          if (!showMarkers && !big) return null;
          const s = big ? 7 : 5;
          return <rect key={`m${i}`} className={`mc-mark${st === 'forecast' ? ' mc-mark--fc' : ''}${big ? ' is-on' : ''}`} x={x.mid(i) - s / 2} y={y(v) - s / 2} width={s} height={s} />;
        })}

      {/* end label */}
      {endLabel && last >= 0 && !isHidden('actual') && (
        <text className="mc-endlbl" x={Math.min(x.mid(last), width - M.right)} y={y(data.actual[last] as number) - 10} textAnchor={x.mid(last) > width - 60 ? 'end' : 'middle'}>
          {formatValue(data.actual[last], unit, { compact: true })}
        </text>
      )}

      <XLabels labels={data.periods.map((p) => p.label)} x={x.mid} y={plotBottom + 18} every={every} current={active ?? last} sub={every <= 2 ? yearMarks(data) : undefined} />

      {/* hit layer: pointer + keyboard */}
      {data.periods.map((p, i) => {
        const props = roving.getProps(i);
        return (
          <g key={`h${i}`} className="mc-pt" role={onDrill ? 'button' : 'img'} aria-label={timePointLabel(data, i, unit, direction, labels, isHidden)} {...props} onPointerEnter={() => setActive(i)}>
            <rect className="mc-hit" x={x.mid(i) - x.step / 2} y={M.top} width={x.step} height={plotBottom - M.top} />
          </g>
        );
      })}
    </PlotFrame>
  );
}
