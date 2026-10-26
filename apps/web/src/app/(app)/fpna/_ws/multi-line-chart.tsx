'use client';

/**
 * Several measures of ONE unit on one axis (margins, working-capital days, leverage): built
 * from the chart kit's frame, axes, tooltip and roving focus. Each line has its own colour
 * AND dash, so it reads without colour; preliminary months are hatched; a missing month is a
 * gap (the line breaks), never zero. ← → walk the months; the tooltip lists every line.
 */
import { useMemo } from 'react';
import { formatValue } from '@/components/charts';
import { ChartDefs, fillStyle, fillUrl, PlotFrame, Tooltip, XLabels, YAxis } from '@/components/charts/core/parts';
import { useActive, useChartCard, useContainerWidth, useRoving, useSvgId } from '@/components/charts/core/hooks';
import { labelEvery, linearScale, pointScale, textWidth, ticksForUnit } from '@/components/charts/core/scale';
import type { WsChartPeriod, WsUnit, WsValue } from '@/lib/fpna/workspace/types';
import s from './fpna.module.css';

export interface MultiLineChartProps {
  periods: WsChartPeriod[];
  unit: WsUnit;
  lines: Array<{ key: string; label: string; values: WsValue[] }>;
  height?: number;
  onDrill?: (periodKey: string) => void;
}

const M = { top: 12, right: 12, bottom: 30 };
const LINE_CLS = [s.l0, s.l1, s.l2, s.l3];
const SW_CLS = ['', s.sw1, s.sw2, s.sw3];
const isNum = (v: WsValue | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

export function MultiLineLegend({ lines }: { lines: Array<{ key: string; label: string }> }) {
  return (
    <div className={s.legend} aria-hidden="true">
      {lines.map((l, i) => (
        <span key={l.key}>
          <i className={`${s.sw} ${SW_CLS[i % 4]}`} />
          {l.label}
        </span>
      ))}
    </div>
  );
}

export function MultiLineChart({ periods, unit, lines, height = 240, onDrill }: MultiLineChartProps) {
  const id = useSvgId('ml');
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const { labelledBy } = useChartCard();
  const [active, setActive] = useActive();
  const n = periods.length;

  const geo = useMemo(() => {
    const all = lines.flatMap((l) => l.values.filter(isNum));
    const lo = all.length ? Math.min(...all) : 0;
    const hi = all.length ? Math.max(...all) : 1;
    const t = ticksForUnit(lo, hi, unit, width < 480 ? 3 : 4, false);
    const left = Math.max(...t.ticks.map((v) => textWidth(formatValue(v, unit, { compact: true })))) + 12;
    const x = pointScale(n, [left, width - M.right], 1);
    const y = linearScale([t.min, t.max], [height - M.bottom, M.top]);
    return { t, x, y, left, every: labelEvery(n, width - left - M.right, width < 480 ? 44 : 34) };
  }, [lines, unit, width, height, n]);
  const { t, x, y, left, every } = geo;
  const plotBottom = height - M.bottom;

  const roving = useRoving(n, { onActivate: onDrill ? (i) => onDrill(periods[i].key) : undefined, onFocusIndex: setActive, isFocusable: () => true });

  const path = (vals: WsValue[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (!isNum(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x.mid(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const tip =
    active !== null && active >= 0 && active < n ? (
      <Tooltip
        x={x.mid(active)}
        y={M.top}
        width={width}
        title={periods[active].longLabel}
        status={periods[active].status === 'preliminary' ? 'Preliminary' : undefined}
        rows={lines.map((l) => ({ label: l.label, value: formatValue(l.values[active] ?? null, unit) }))}
      />
    ) : null;

  return (
    <PlotFrame frameRef={ref} width={width} height={height} labelledBy={labelledBy} overlay={tip} onPointerLeave={() => setActive(null)} className={onDrill ? 'is-drillable' : undefined}>
      <ChartDefs id={id} />
      {periods.map((p, i) =>
        p.status === 'preliminary' ? <rect key={`pc${i}`} className="mc-prelim-col" x={x.mid(i) - x.step / 2} y={M.top} width={x.step} height={plotBottom - M.top} style={fillStyle(fillUrl(id, 'col'))} /> : null,
      )}
      <YAxis ticks={t.ticks} y={y} unit={unit} x0={left} x1={width - M.right} labelX={left - 8} />
      {lines.map((l, k) => (
        <path key={l.key} className={LINE_CLS[k % 4]} d={path(l.values)} />
      ))}
      {active !== null && <line className="mc-cross" x1={x.mid(active)} x2={x.mid(active)} y1={M.top} y2={plotBottom} />}
      <XLabels labels={periods.map((p) => p.label)} x={x.mid} y={plotBottom + 18} every={every} current={active ?? n - 1} />
      {periods.map((p, i) => {
        const props = roving.getProps(i);
        return (
          <g
            key={`h${i}`}
            className="mc-pt"
            role={onDrill ? 'button' : 'img'}
            aria-label={`${p.longLabel}: ${lines.map((l) => `${l.label} ${formatValue(l.values[i] ?? null, unit)}`).join(', ')}`}
            {...props}
            onPointerEnter={() => setActive(i)}
          >
            <rect className="mc-hit" x={x.mid(i) - x.step / 2} y={M.top} width={x.step} height={plotBottom - M.top} />
          </g>
        );
      })}
    </PlotFrame>
  );
}
