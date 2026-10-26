'use client';

/**
 * ComboChart — bars on the left axis + a line on a SECONDARY axis, for pairs of
 * different units only (revenue $ with gross margin %, headcount with revenue
 * per head). Never two money series on two axes: that is how charts lie. Both
 * axes are titled with their swatch so the reader always knows which is which.
 * (MonthlyCombo's TTM uses a synced sub-panel instead, per the frame contract.)
 */
import { useMemo } from 'react';
import { axisLabels, formatValue } from './core/format';
import { useActive, useChartCard, useContainerWidth, useHidden, useRoving, useSvgId } from './core/hooks';
import { ChartDefs, fillUrl, PlotFrame, Tooltip, XLabels, YAxis, fillStyle } from './core/parts';
import { bandScale, labelEvery, linearScale, textWidth, ticksForUnit, extent } from './core/scale';
import { segments } from './core/series';
import { longLabel, periodStatus, type ChartPeriod, type ChartUnit, type Value } from './core/types';

export interface ComboSeries {
  key: string;
  label: string;
  values: Value[];
  unit: ChartUnit;
}

export interface ComboChartProps {
  periods: ReadonlyArray<ChartPeriod>;
  bars: ComboSeries;
  line: ComboSeries;
  height?: number;
  hidden?: ReadonlyArray<string>;
  onDrill?: (periodKey: string) => void;
  ariaLabel?: string;
}

const M = { top: 28, bottom: 30 };

function isNum(v: Value | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

export function ComboChart({ periods, bars, line, height = 260, hidden: hiddenProp, onDrill, ariaLabel }: ComboChartProps) {
  if (bars.unit === line.unit && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.warn('[charts] ComboChart: both series share a unit — use one axis (BarChart / MonthlyCombo) instead.');
  }
  const id = useSvgId('cb');
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const isHidden = useHidden(hiddenProp);
  const { labelledBy } = useChartCard();
  const [active, setActive] = useActive();
  const n = periods.length;

  const geo = useMemo(() => {
    const [blo, bhi] = extent(bars.values) ?? [0, 1];
    const [llo, lhi] = extent(line.values) ?? [0, 1];
    const tb = ticksForUnit(blo, bhi, bars.unit, 4, true);
    // Secondary axis: same NUMBER of intervals as the primary so gridlines align.
    const intervals = tb.ticks.length - 1;
    const tl = ticksForUnit(Math.min(0, llo), lhi, line.unit, intervals, line.unit !== 'percent' || llo >= 0);
    const left = Math.max(...axisLabels(tb.ticks, bars.unit).map((s) => textWidth(s))) + 12;
    const right = Math.max(...axisLabels(tl.ticks, line.unit).map((s) => textWidth(s))) + 12;
    const x = bandScale(n, [left, width - right], 0.32, 0.1);
    const yb = linearScale([tb.min, tb.max], [height - M.bottom, M.top]);
    const yl = linearScale([tl.min, tl.max], [height - M.bottom, M.top]);
    return { tb, tl, x, yb, yl, left, right, every: labelEvery(n, width - left - right, 36, periods.map((p) => p.label)) };
  }, [bars, line, width, height, n]);

  const { tb, tl, x, yb, yl, left, right, every } = geo;
  const zero = yb(Math.max(tb.min, Math.min(0, tb.max)));
  const roving = useRoving(n, { onActivate: onDrill ? (i) => onDrill(periods[i].key) : undefined, onFocusIndex: setActive });

  const label = (i: number) =>
    `${longLabel(periods[i])}${periodStatus(periods[i]) !== 'closed' ? `, ${periodStatus(periods[i])}` : ''}: ${bars.label} ${formatValue(bars.values[i] ?? null, bars.unit)}; ${line.label} ${formatValue(line.values[i] ?? null, line.unit)}`;

  const tip =
    active !== null ? (
      <Tooltip
        x={x.mid(active)}
        y={M.top}
        width={width}
        title={longLabel(periods[active])}
        status={periodStatus(periods[active]) === 'closed' ? undefined : periodStatus(periods[active]) === 'preliminary' ? 'Preliminary' : 'Forecast'}
        rows={[
          { label: bars.label, value: formatValue(bars.values[active] ?? null, bars.unit), swatch: 'solid', strong: true },
          { label: line.label, value: formatValue(line.values[active] ?? null, line.unit), swatch: 'line' },
        ]}
      />
    ) : null;

  return (
    <PlotFrame frameRef={ref} width={width} height={height} labelledBy={labelledBy} label={ariaLabel} overlay={tip} onPointerLeave={() => setActive(null)} className={onDrill ? 'is-drillable' : undefined}>
      <ChartDefs id={id} />
      <g aria-hidden="true" className="mc-axtitle">
        <AxisTitle x={left} anchor="start" text={`${bars.label} (left)`} kind="bar" />
        <AxisTitle x={width - right} anchor="end" text={`${line.label} (right)`} kind="line" />
      </g>
      <YAxis ticks={tb.ticks} y={yb} unit={bars.unit} x0={left} x1={width - right} labelX={left - 8} />
      <YAxis ticks={tl.ticks} y={yl} unit={line.unit} x0={left} x1={width - right} labelX={width - right + 8} side="right" showGrid={false} />
      {!isHidden(bars.key) &&
        bars.values.map((v, i) => {
          if (!isNum(v)) return null;
          const st = periodStatus(periods[i]);
          return (
            <rect
              key={`b${i}`}
              className={`mc-bar${st === 'preliminary' ? ' mc-bar--prelim' : st === 'forecast' ? ' mc-bar--fc' : ''} mc-bar--soft${i === active ? ' is-on' : ''}`}
              x={x.x(i)}
              y={Math.min(yb(v), zero)}
              width={x.bandwidth}
              height={Math.max(1, Math.abs(zero - yb(v)))}
              style={fillStyle(st === 'preliminary' ? fillUrl(id, 'prelim') : undefined)}
            />
          );
        })}
      {!isHidden(line.key) &&
        segments(line.values).map((s, k) => {
          let d = '';
          for (let i = s.start; i <= s.end; i++) d += `${d ? 'L' : 'M'}${x.mid(i).toFixed(1)},${yl(line.values[i] as number).toFixed(1)}`;
          return <path key={`l${k}`} className="mc-line mc-line--alt" d={d} />;
        })}
      {!isHidden(line.key) && line.values.map((v, i) => (isNum(v) ? <rect key={`m${i}`} className={`mc-mark mc-mark--alt${i === active ? ' is-on' : ''}`} x={x.mid(i) - 3} y={yl(v) - 3} width={6} height={6} /> : null))}
      {active !== null && <line className="mc-cross" x1={x.mid(active)} x2={x.mid(active)} y1={M.top} y2={height - M.bottom} />}
      <XLabels labels={periods.map((p) => p.label)} x={x.mid} y={height - 12} every={every} current={active ?? undefined} />
      {periods.map((p, i) => (
        <g key={`h${i}`} className="mc-pt" role={onDrill ? 'button' : 'img'} aria-label={label(i)} {...roving.getProps(i)} onPointerEnter={() => setActive(i)}>
          <rect className="mc-hit" x={x.mid(i) - x.step / 2} y={M.top} width={x.step} height={height - M.top - M.bottom} />
        </g>
      ))}
    </PlotFrame>
  );
}

/** Axis title with an inline SVG swatch (the legend lives on the card). */
function AxisTitle({ x, anchor, text, kind }: { x: number; anchor: 'start' | 'end'; text: string; kind: 'bar' | 'line' }) {
  const w = textWidth(text) + 18;
  const x0 = anchor === 'start' ? x : x - w;
  return (
    <g>
      {kind === 'bar' ? <rect className="mc-bar mc-bar--soft" x={x0} y={6} width={10} height={10} /> : <line className="mc-line mc-line--alt" x1={x0} x2={x0 + 12} y1={11} y2={11} />}
      <text className="mc-tick mc-tick--axis" x={x0 + 16} y={15}>
        {text}
      </text>
    </g>
  );
}

