'use client';

/**
 * MonthlyCombo — the portal's flagship (M3), rebuilt on the Merit kit:
 *   bars by month (Electric) · same month a year earlier as a dashed Midnight
 *   line · approved budget as tick marks · preliminary months hatched ·
 *   forecast months outlined · a loss month hatched brick below zero ·
 *   TTM in a SYNCED sub-panel underneath (never a second axis).
 * One y-axis; bars start at zero; reads without colour.
 */
import { useMemo } from 'react';
import { formatValue } from './core/format';
import { useActive, useChartCard, useContainerWidth, useHidden, useRoving, useSvgId } from './core/hooks';
import { ChartDefs, fillUrl, PlotFrame, Tooltip, XLabels, YAxis, fillStyle } from './core/parts';
import { bandScale, labelEvery, linearScale, textWidth, ticksForUnit } from './core/scale';
import { lastIndex, segments } from './core/series';
import { statusWord, timeExtent, timePointLabel, timeTooltipRows, yearMarks, type SeriesLabels } from './core/time';
import { longLabel, periodStatus, type ChartUnit, type MetricDirection, type TimeSeriesData, type Value } from './core/types';

export interface MonthlyComboProps {
  data: TimeSeriesData;
  unit: ChartUnit;
  direction: MetricDirection;
  /** Main panel height (the TTM panel adds `ttmHeight` + 16). */
  height?: number;
  ttmHeight?: number;
  labels?: SeriesLabels;
  hidden?: ReadonlyArray<string>;
  onDrill?: (periodKey: string) => void;
  ariaLabel?: string;
}

const M = { top: 16, right: 12, bottom: 30 };

function isNum(v: Value | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

export function MonthlyCombo({ data, unit, direction, height = 240, ttmHeight = 72, labels, hidden: hiddenProp, onDrill, ariaLabel }: MonthlyComboProps) {
  const id = useSvgId('mc');
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const isHidden = useHidden(hiddenProp);
  const { labelledBy } = useChartCard();
  const [active, setActive] = useActive();
  const n = data.periods.length;
  const showTtm = !!data.ttm && !isHidden('ttm') && data.ttm.some(isNum);
  const total = height + (showTtm ? ttmHeight + 16 : 0);

  const geo = useMemo(() => {
    const narrow = width < 480;
    const [lo, hi] = timeExtent(data, isHidden);
    const t = ticksForUnit(lo, hi, unit, narrow ? 3 : 4, true);
    let left = Math.max(...t.ticks.map((v) => textWidth(formatValue(v, unit, { compact: true })))) + 12;
    let tt: ReturnType<typeof ticksForUnit> | null = null;
    if (showTtm && data.ttm) {
      const vals = data.ttm.filter(isNum);
      tt = ticksForUnit(Math.min(...vals), Math.max(...vals), unit, 2, false);
      left = Math.max(left, ...tt.ticks.map((v) => textWidth(formatValue(v, unit, { compact: true })) + 12));
    }
    const x = bandScale(n, [left, width - M.right], n > 18 ? 0.3 : 0.36, 0.12);
    const y = linearScale([t.min, t.max], [height - M.bottom, M.top]);
    const ty = tt ? linearScale([tt.min, tt.max], [height + 16 + ttmHeight - 8, height + 16 + 14]) : null;
    return { t, tt, x, y, ty, left, every: labelEvery(n, width - left - M.right, narrow ? 44 : 34, data.periods.map((p) => p.label)) };
  }, [data, isHidden, unit, width, n, height, showTtm, ttmHeight]);

  const { t, tt, x, y, ty, left, every } = geo;
  const plotBottom = height - M.bottom;
  const zeroY = y(Math.max(t.min, Math.min(0, t.max)));
  const last = lastIndex(data.actual);

  const roving = useRoving(n, {
    onActivate: onDrill ? (i) => onDrill(data.periods[i].key) : undefined,
    onFocusIndex: setActive,
  });

  const tickW = Math.min(x.bandwidth + 8, x.bandwidth * 1.5);

  const tip =
    active !== null ? (
      <Tooltip
        x={x.mid(active)}
        y={isNum(data.actual[active]) ? Math.min(y(data.actual[active] as number), zeroY) - 24 : M.top}
        width={width}
        title={longLabel(data.periods[active])}
        status={statusWord(data, active)}
        rows={timeTooltipRows(data, active, unit, direction, labels, isHidden)}
      />
    ) : null;

  const pyPath = (vals: ReadonlyArray<Value>, s: { start: number; end: number }, scale: (v: number) => number) => {
    let d = '';
    for (let i = s.start; i <= s.end; i++) {
      const v = vals[i];
      if (isNum(v)) d += `${d ? 'L' : 'M'}${x.mid(i).toFixed(1)},${scale(v).toFixed(1)}`;
    }
    return d;
  };

  return (
    <PlotFrame
      frameRef={ref}
      width={width}
      height={total}
      labelledBy={labelledBy}
      label={ariaLabel}
      overlay={tip}
      onPointerLeave={() => setActive(null)}
      className={onDrill ? 'is-drillable' : undefined}
    >
      <ChartDefs id={id} />
      <YAxis ticks={t.ticks} y={y} unit={unit} x0={left} x1={width - M.right} labelX={left - 8} />

      {/* hover column */}
      {active !== null && <rect className="mc-colhi" x={x.mid(active) - x.step / 2} y={M.top - 8} width={x.step} height={total - M.top} />}

      {/* bars */}
      {!isHidden('actual') &&
        data.actual.map((v, i) => {
          const st = periodStatus(data.periods[i]);
          if (!isNum(v)) {
            return st === 'forecast' ? null : (
              <g key={`gap${i}`} aria-hidden="true">
                <line className="mc-gapline" x1={x.mid(i)} x2={x.mid(i)} y1={M.top} y2={plotBottom} />
                <text className="mc-gaptxt" x={x.mid(i)} y={zeroY - 6} textAnchor="middle">
                  n/a
                </text>
              </g>
            );
          }
          const y0 = Math.min(y(v), zeroY);
          const h = Math.max(1, Math.abs(zeroY - y(v)));
          const loss = v < 0 && direction === 'higher_is_better';
          const cls = loss ? 'mc-bar mc-bar--neg' : st === 'preliminary' ? 'mc-bar mc-bar--prelim' : st === 'forecast' ? 'mc-bar mc-bar--fc' : 'mc-bar';
          const fill = loss ? fillUrl(id, 'neg') : st === 'preliminary' ? fillUrl(id, 'prelim') : undefined;
          return <rect key={`b${i}`} className={`${cls}${i === active ? ' is-on' : ''}`} x={x.x(i)} y={y0} width={x.bandwidth} height={h} style={fillStyle(fill)} />;
        })}

      {/* budget ticks */}
      {data.budget && !isHidden('budget') &&
        data.budget.map((b, i) => (isNum(b) ? <line key={`bt${i}`} className="mc-bud" x1={x.mid(i) - tickW / 2} x2={x.mid(i) + tickW / 2} y1={y(b)} y2={y(b)} /> : null))}

      {/* prior year — dashed Midnight over the bars */}
      {data.priorYear && !isHidden('priorYear') && segments(data.priorYear).map((s, k) => <path key={`py${k}`} className="mc-py" d={pyPath(data.priorYear ?? [], s, y)} />)}
      {data.priorYear && !isHidden('priorYear') && data.priorYear.map((v, i) => (isNum(v) && (i === active || n <= 14) ? <circle key={`pyd${i}`} className="mc-py-dot" cx={x.mid(i)} cy={y(v)} r={i === active ? 3 : 2} /> : null))}

      {/* latest value */}
      {last >= 0 && !isHidden('actual') && (
        <text className="mc-endlbl" x={x.mid(last)} y={Math.min(y(data.actual[last] as number), zeroY) - 8} textAnchor={x.mid(last) > width - 40 ? 'end' : 'middle'}>
          {formatValue(data.actual[last], unit, { compact: true })}
        </text>
      )}

      <XLabels labels={data.periods.map((p) => p.label)} x={x.mid} y={plotBottom + 18} every={every} current={active ?? last} sub={every <= 2 ? yearMarks(data) : undefined} />

      {/* TTM sub-panel — synced x, its own scale, never a second axis on the bars */}
      {showTtm && tt && ty && data.ttm && (
        <g className="mc-ttm" aria-hidden="true">
          <line className="mc-ttm-rule" x1={left} x2={width - M.right} y1={height + 16} y2={height + 16} />
          <text className="mc-ttm-lbl" x={left} y={height + 16 + 12}>
            TTM
          </text>
          {tt.ticks.map((v) => (
            <text key={v} className="mc-tick" x={left - 8} y={ty(v)} dy="0.32em" textAnchor="end">
              {formatValue(v, unit, { compact: true })}
            </text>
          ))}
          {segments(data.ttm).map((s, k) => (
            <path key={`tt${k}`} className="mc-ttm-line" d={pyPath(data.ttm ?? [], s, ty)} />
          ))}
          {active !== null && isNum(data.ttm[active]) && <rect className="mc-mark is-on" x={x.mid(active) - 3} y={ty(data.ttm[active] as number) - 3} width={6} height={6} />}
          {(() => {
            const li = lastIndex(data.ttm);
            return li >= 0 && active === null ? (
              <text className="mc-endlbl mc-endlbl--sm" x={x.mid(li)} y={ty(data.ttm[li] as number) - 8} textAnchor="end">
                {formatValue(data.ttm[li], unit, { compact: true })}
              </text>
            ) : null;
          })()}
        </g>
      )}

      {/* keyboard + pointer targets: one per month, spanning both panels */}
      {data.periods.map((p, i) => (
        <g key={`h${i}`} className="mc-pt" role={onDrill ? 'button' : 'img'} aria-label={timePointLabel(data, i, unit, direction, labels, isHidden)} {...roving.getProps(i)} onPointerEnter={() => setActive(i)}>
          <rect className="mc-hit" x={x.mid(i) - x.step / 2} y={M.top - 8} width={x.step} height={total - M.top} />
        </g>
      ))}
    </PlotFrame>
  );
}
