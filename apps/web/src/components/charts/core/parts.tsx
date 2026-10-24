'use client';

/**
 * Shared SVG / HTML parts: hatch patterns, axes, the plot frame and the tooltip.
 * Every colour is a class in charts.css (kit tokens) — nothing hard-coded here,
 * so print, export and a future dark context restyle from one place.
 */
import type { ReactNode, RefObject } from 'react';
import { axisLabels } from './format';
import type { LinearScale } from './scale';
import type { ChartUnit } from './types';

/**
 * Hatches. Preliminary = Electric stripes on Blue-200 (the boards' hatch-com);
 * unfavourable = brick stripes on white (hatch-neg); not-available = grey
 * stripes. Ids are prefixed per chart so several charts can share a page and
 * every exported SVG carries its own defs.
 */
export function ChartDefs({ id }: { id: string }) {
  return (
    <defs>
      <pattern id={`${id}-prelim`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect className="mc-pt-prelim-bg" width="6" height="6" />
        <rect className="mc-pt-prelim-fg" width="2.5" height="6" />
      </pattern>
      <pattern id={`${id}-neg`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect className="mc-pt-neg-bg" width="5" height="5" />
        <rect className="mc-pt-neg-fg" width="1.6" height="5" />
      </pattern>
      <pattern id={`${id}-col`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect className="mc-pt-col-fg" width="1" height="6" />
      </pattern>
      <pattern id={`${id}-na`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect className="mc-pt-na-bg" width="6" height="6" />
        <rect className="mc-pt-na-fg" width="1" height="6" />
      </pattern>
      <pattern id={`${id}-warn`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect className="mc-pt-warn-bg" width="5" height="5" />
        <rect className="mc-pt-warn-fg" width="1.2" height="5" />
      </pattern>
    </defs>
  );
}

export const fillUrl = (id: string, kind: 'prelim' | 'neg' | 'col' | 'na' | 'warn') => `url(#${id}-${kind})`;

/** Horizontal gridlines + y labels at the left; the zero line drawn in Midnight. */
export function YAxis({
  ticks,
  y,
  unit,
  x0,
  x1,
  labelX,
  side = 'left',
  showGrid = true,
}: {
  ticks: readonly number[];
  y: LinearScale;
  unit: ChartUnit;
  x0: number;
  x1: number;
  labelX: number;
  side?: 'left' | 'right';
  showGrid?: boolean;
}) {
  const labels = axisLabels(ticks, unit);
  return (
    <g className="mc-yaxis" aria-hidden="true">
      {ticks.map((t, i) => (
        <g key={t}>
          {showGrid && <line className={t === 0 ? 'mc-zero' : 'mc-grid'} x1={x0} x2={x1} y1={Math.round(y(t)) + 0.5} y2={Math.round(y(t)) + 0.5} />}
          <text className="mc-tick" x={labelX} y={y(t)} dy="0.32em" textAnchor={side === 'left' ? 'end' : 'start'}>
            {labels[i]}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Period / category labels along the bottom; every nth when crowded, the last always. */
export function XLabels({
  labels,
  x,
  y,
  every = 1,
  current,
  sub,
}: {
  labels: readonly string[];
  x: (i: number) => number;
  y: number;
  every?: number;
  current?: number;
  /** Optional second line under some labels (year change: "’26"). */
  sub?: ReadonlyArray<string | undefined>;
}) {
  const n = labels.length;
  return (
    <g className="mc-xaxis" aria-hidden="true">
      {labels.map((l, i) => {
        const show = i % every === 0 || i === n - 1 || i === current;
        if (!show) return null;
        // Don't let the forced last label collide with the previous shown one.
        if (i === n - 1 && every > 1 && (n - 1) % every !== 0 && (n - 1) % every < Math.ceil(every / 2) && i !== current) return null;
        return (
          <text key={i} className={i === current ? 'mc-tick mc-tick--cur' : 'mc-tick'} x={x(i)} y={y} textAnchor="middle">
            {l}
            {sub?.[i] && (
              <tspan className="mc-tick mc-tick--sub" x={x(i)} dy="14">
                {sub[i]}
              </tspan>
            )}
          </text>
        );
      })}
    </g>
  );
}

/**
 * The plot frame: fixed height (no layout shift), measured width, the SVG and
 * an HTML overlay for the tooltip. The SVG is a labelled group: its name is the
 * card title + summary sentence, and its focusable points carry their values.
 */
export function PlotFrame({
  frameRef,
  width,
  height,
  label,
  labelledBy,
  children,
  overlay,
  className,
  onPointerLeave,
}: {
  frameRef: RefObject<HTMLDivElement>;
  width: number;
  height: number;
  /** Used when the chart is not inside a ChartCard. */
  label?: string;
  labelledBy?: string;
  children: ReactNode;
  overlay?: ReactNode;
  className?: string;
  onPointerLeave?: () => void;
}) {
  return (
    <div ref={frameRef} className={className ? `mc-plot ${className}` : 'mc-plot'} style={{ height }} onPointerLeave={onPointerLeave}>
      <svg
        className="mc-svg"
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMinYMin meet"
        role="group"
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-roledescription="chart"
      >
        {children}
      </svg>
      {overlay}
    </div>
  );
}

export interface TooltipRow {
  label: string;
  value: string;
  /** Swatch encoding beside the label. */
  swatch?: SwatchKind;
  /** pos / neg colouring for F/U lines. */
  tone?: 'pos' | 'neg' | 'muted';
  strong?: boolean;
}

/** Positioned HTML tooltip (pointer-events none); flips left near the right edge. */
export function Tooltip({ x, y, width, title, status, rows }: { x: number; y: number; width: number; title: string; status?: string; rows: TooltipRow[] }) {
  const flip = x > width - 220;
  return (
    <div className="mc-tip" role="presentation" style={{ left: flip ? undefined : x + 12, right: flip ? width - x + 12 : undefined, top: Math.max(0, y) }}>
      <div className="mc-tip-h">
        <span>{title}</span>
        {status && <span className="mc-tip-st">{status}</span>}
      </div>
      <dl>
        {rows.map((r, i) => (
          <div key={i} className={r.strong ? 'mc-tip-r is-strong' : 'mc-tip-r'}>
            <dt>
              {r.swatch && <Swatch kind={r.swatch} />}
              {r.label}
            </dt>
            <dd className={r.tone ? `is-${r.tone}` : undefined}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export type SwatchKind =
  | 'solid'
  | 'solid-1'
  | 'solid-2'
  | 'solid-3'
  | 'solid-4'
  | 'solid-5'
  | 'line'
  | 'dashed'
  | 'dotted'
  | 'tick'
  | 'prelim'
  | 'neg'
  | 'band'
  | 'anchor'
  | 'outline'
  | 'warn';

/** Legend / tooltip swatch: shape AND pattern, never colour alone. */
export function Swatch({ kind }: { kind: SwatchKind }) {
  return <i className={`mc-sw mc-sw--${kind}`} aria-hidden="true" />;
}

/** Series palette classes — luminance-separated blues + neutrals (CVD-safe). */
export const SERIES_CLASSES = ['mc-s0', 'mc-s1', 'mc-s2', 'mc-s3', 'mc-s4', 'mc-s5'] as const;
export const SERIES_SWATCH: SwatchKind[] = ['solid', 'solid-1', 'solid-2', 'solid-3', 'solid-4', 'solid-5'];
export function seriesClass(i: number): string {
  return SERIES_CLASSES[i % SERIES_CLASSES.length];
}

/**
 * Pattern fills go through `style`, not the `fill` attribute: CSS class rules
 * (.mc-bar{fill:…}) beat presentation attributes, so an attribute would lose.
 */
export function fillStyle(url: string | undefined): { fill: string } | undefined {
  return url ? { fill: url } : undefined;
}
