'use client';

/**
 * WaterfallChart — the bridge (EBITDA, gross margin, cash, working capital,
 * NI → cash). Anchors in Midnight from zero; favourable steps solid Electric,
 * unfavourable hatched brick; dotted connectors carry the running total.
 * Columns on wide screens, rows below 560px (labels never rotate). An end
 * figure that does not tie to the steps is drawn dashed and footnoted.
 */
import { useMemo } from 'react';
import { formatValue } from './core/format';
import { useActive, useChartCard, useContainerWidth, useRoving, useSvgId } from './core/hooks';
import { ChartDefs, fillUrl, PlotFrame, Tooltip, YAxis, fillStyle } from './core/parts';
import { bandScale, linearScale, textWidth, ticksForUnit } from './core/scale';
import { computeBridge, type BridgeBar, type BridgeStep } from './core/series';
import type { ChartUnit, MetricDirection } from './core/types';

export interface WaterfallChartProps {
  steps: ReadonlyArray<BridgeStep>;
  unit?: ChartUnit;
  /** Default direction of the deltas (a cost bridge passes 'lower_is_better'). */
  direction?: MetricDirection;
  height?: number;
  /** Force an orientation; default: columns ≥ 560px, rows below. */
  orientation?: 'vertical' | 'horizontal';
  onDrill?: (stepKey: string) => void;
  ariaLabel?: string;
}

function wrap(label: string, maxPx: number): string[] {
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textWidth(next) > maxPx && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  if (lines.length > 2) return [lines[0], `${lines.slice(1).join(' ').slice(0, Math.max(4, Math.floor(maxPx / 6.5) - 1))}…`];
  return lines;
}

function barClass(b: BridgeBar, ties: boolean): string {
  if (b.kind !== 'delta') return `mc-rect mc-anchor${b.kind === 'end' && !ties ? ' is-untied' : ''}${b.kind === 'subtotal' ? ' mc-anchor--sub' : ''}`;
  if (b.favourable === false) return 'mc-rect mc-bar--neg';
  if (b.favourable === null) return 'mc-rect mc-s3';
  return 'mc-rect mc-s0';
}

export function WaterfallChart({ steps, unit = 'money', direction = 'higher_is_better', height: hProp, orientation, onDrill, ariaLabel }: WaterfallChartProps) {
  const id = useSvgId('wf');
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  const { labelledBy } = useChartCard();
  const [active, setActive] = useActive();
  const bridge = useMemo(() => computeBridge(steps, direction), [steps, direction]);
  const n = bridge.bars.length;
  const horizontal = orientation ? orientation === 'horizontal' : width < 560;
  const height = hProp ?? (horizontal ? n * 34 + 36 : 280);

  const geo = useMemo(() => {
    const vals = bridge.bars.flatMap((b) => [b.from, b.to]);
    const t = ticksForUnit(Math.min(0, ...vals), Math.max(0, ...vals), unit, horizontal || width < 480 ? 3 : 4, true);
    if (horizontal) {
      const labelW = Math.min(Math.round(width * 0.38), Math.max(...bridge.bars.map((b) => textWidth(b.label, 13))) + 16);
      const v = linearScale([t.min, t.max], [labelW, width - 64]);
      const band = bandScale(n, [4, height - 28], 0.3, 0.04);
      return { t, v, band, labelW, left: 0 };
    }
    const left = Math.max(...t.ticks.map((x) => textWidth(formatValue(x, unit, { compact: true })))) + 12;
    const v = linearScale([t.min, t.max], [height - 44, 20]);
    const band = bandScale(n, [left, width - 8], 0.28, 0.08);
    return { t, v, band, labelW: 0, left };
  }, [bridge, unit, horizontal, width, height, n]);

  const { t, v, band, left } = geo;
  const roving = useRoving(n, { initial: 0, onActivate: onDrill ? (i) => onDrill(bridge.bars[i].key) : undefined, onFocusIndex: setActive });

  const rect = (b: BridgeBar, i: number) => {
    const lo = Math.min(b.from, b.to);
    const hi = Math.max(b.from, b.to);
    if (horizontal) return { x: v(lo), y: band.x(i), w: Math.max(1, v(hi) - v(lo)), h: band.bandwidth };
    return { x: band.x(i), y: v(hi), w: band.bandwidth, h: Math.max(1, v(lo) - v(hi)) };
  };

  const pointLabel = (b: BridgeBar) =>
    b.kind === 'delta'
      ? `${b.label}: ${formatValue(b.value, unit, { delta: true })}${b.favourable === null ? '' : b.favourable ? ', favourable' : ', unfavourable'}; running total ${formatValue(b.running, unit)}`
      : `${b.label}: ${formatValue(b.value, unit)}`;

  const a = active !== null ? bridge.bars[active] : null;
  const ar = a && active !== null ? rect(a, active) : null;
  const tip =
    a && ar ? (
      <Tooltip
        x={horizontal ? ar.x + ar.w : ar.x + ar.w / 2}
        y={horizontal ? ar.y - 8 : ar.y - 24}
        width={width}
        title={a.label}
        rows={
          a.kind === 'delta'
            ? [
                { label: 'Movement', value: formatValue(a.value, unit, { delta: true }), tone: a.favourable === null ? 'muted' : a.favourable ? 'pos' : 'neg', strong: true },
                { label: 'Running total', value: formatValue(a.running, unit) },
              ]
            : [{ label: a.kind === 'subtotal' ? 'Subtotal' : 'Total', value: formatValue(a.value, unit), strong: true }, ...(a.kind === 'end' && !bridge.ties ? [{ label: 'Does not tie by', value: formatValue(bridge.difference, unit), tone: 'neg' as const }] : [])]
        }
      />
    ) : null;

  return (
    <PlotFrame frameRef={ref} width={width} height={height} labelledBy={labelledBy} label={ariaLabel} overlay={tip} onPointerLeave={() => setActive(null)} className={onDrill ? 'is-drillable' : undefined}>
      <ChartDefs id={id} />
      {horizontal ? (
        <g aria-hidden="true">
          {t.ticks.map((x) => (
            <g key={x}>
              <line className={x === 0 ? 'mc-zero' : 'mc-grid'} x1={v(x)} x2={v(x)} y1={0} y2={height - 24} />
              <text className="mc-tick" x={v(x)} y={height - 8} textAnchor="middle">
                {formatValue(x, unit, { compact: true })}
              </text>
            </g>
          ))}
        </g>
      ) : (
        <YAxis ticks={t.ticks} y={v} unit={unit} x0={left} x1={width - 8} labelX={left - 8} />
      )}

      {/* connectors */}
      {bridge.bars.slice(0, -1).map((b, i) => {
        const r = rect(b, i);
        const next = rect(bridge.bars[i + 1], i + 1);
        const level = v(b.running);
        return horizontal ? (
          <line key={`c${i}`} className="mc-conn" x1={level} x2={level} y1={r.y + r.h} y2={next.y} aria-hidden="true" />
        ) : (
          <line key={`c${i}`} className="mc-conn" x1={r.x + r.w} x2={next.x} y1={level} y2={level} aria-hidden="true" />
        );
      })}

      {bridge.bars.map((b, i) => {
        const r = rect(b, i);
        const neg = b.kind === 'delta' && b.favourable === false;
        const valText = b.kind === 'delta' ? formatValue(b.value, unit, { compact: true, delta: true }) : formatValue(b.value, unit, { compact: true });
        const goesDown = b.kind === 'delta' ? b.value < 0 : b.value < 0;
        return (
          <g key={b.key} aria-hidden="true">
            <rect className={`${barClass(b, bridge.ties)}${i === active ? ' is-on' : ''}`} x={r.x} y={r.y} width={r.w} height={r.h} style={fillStyle(neg ? fillUrl(id, 'neg') : undefined)} />
            {horizontal ? (
              <>
                <text className={b.kind === 'delta' ? 'mc-cat' : 'mc-cat is-anchor'} x={0} y={band.mid(i)} dy="0.32em">
                  {b.label}
                </text>
                <text className={`mc-vlbl${b.kind !== 'delta' ? ' is-anchor' : neg ? ' is-neg' : ''}`} x={Math.max(r.x + r.w, v(0)) + 6} y={band.mid(i)} dy="0.32em">
                  {valText}
                </text>
              </>
            ) : (
              <>
                <text className={`mc-vlbl${b.kind !== 'delta' ? ' is-anchor' : neg ? ' is-neg' : ''}`} x={r.x + r.w / 2} y={goesDown && b.kind === 'delta' ? r.y + r.h + 14 : r.y - 6} textAnchor="middle">
                  {valText}
                </text>
                <text className={b.kind === 'delta' ? 'mc-cat' : 'mc-cat is-anchor'} x={r.x + r.w / 2} y={height - 26} textAnchor="middle">
                  {wrap(b.label, band.step - 4).map((line, k) => (
                    <tspan key={k} x={r.x + r.w / 2} dy={k === 0 ? 0 : 14}>
                      {line}
                    </tspan>
                  ))}
                </text>
              </>
            )}
          </g>
        );
      })}
      {bridge.bars.map((b, i) => {
        const r = rect(b, i);
        return (
          <g key={`h${b.key}`} className="mc-pt" role={onDrill ? 'button' : 'img'} aria-label={pointLabel(b)} {...roving.getProps(i)} onPointerEnter={() => setActive(i)}>
            <rect className="mc-hit" x={horizontal ? 0 : band.x(i) - (band.step - band.bandwidth) / 2} y={horizontal ? r.y - 4 : 8} width={horizontal ? width : band.step} height={horizontal ? r.h + 8 : height - 16} />
          </g>
        );
      })}
    </PlotFrame>
  );
}
