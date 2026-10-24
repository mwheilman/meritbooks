/**
 * Sparkline — a word-sized trend for KPI tiles and table rows (Tufte). Server-
 * renderable (no hooks): fixed pixel size, role="img" with a sentence label.
 * Gaps break the line; preliminary tail is dotted; the latest point is a square;
 * optional budget/target as a dashed hairline; optional min–max band.
 */
import { describeSparkline } from './core/summary';
import { extent, linearScale } from './core/scale';
import { segments, lastIndex } from './core/series';
import type { ChartUnit, PeriodStatus, Value } from './core/types';

export interface SparklineProps {
  values: ReadonlyArray<Value>;
  unit: ChartUnit;
  /** Metric name for the accessible sentence. */
  metric: string;
  /** Period labels (for the sentence: "Sep 2025 – Aug 2026"). */
  labels?: ReadonlyArray<string>;
  statuses?: ReadonlyArray<PeriodStatus | undefined>;
  width?: number;
  height?: number;
  /** A flat target (budget, covenant, goal). */
  target?: number | null;
  /** Bars instead of a line (monthly volumes). */
  variant?: 'line' | 'bars';
  className?: string;
}

function isNum(v: Value | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

export function Sparkline({ values, unit, metric, labels, statuses, width = 96, height = 24, target, variant = 'line', className }: SparklineProps) {
  const label = describeSparkline(metric, values, unit, labels);
  const e = extent(values, isNum(target) ? [target] : undefined);
  const n = values.length;
  if (!e || n < 2 || values.filter(isNum).length < 2) {
    return (
      <span className={className ? `mc-spark mc-spark--na ${className}` : 'mc-spark mc-spark--na'} role="img" aria-label={label} style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          <line className="mc-spark-na" x1={0} x2={width} y1={height / 2} y2={height / 2} />
        </svg>
      </span>
    );
  }
  let [lo, hi] = e;
  if (variant === 'bars') {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const pad = 2;
  const x = (i: number) => (variant === 'bars' ? ((i + 0.5) / n) * width : pad + (i / (n - 1)) * (width - pad * 2 - 3));
  const y = linearScale([lo, hi], [height - pad, pad]);
  const last = lastIndex(values);
  const firstPrelim = statuses ? statuses.findIndex((s) => s === 'preliminary' || s === 'forecast') : -1;

  const pathFor = (from: number, to: number) => {
    let d = '';
    for (let i = from; i <= to; i++) {
      const v = values[i];
      if (isNum(v)) d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    }
    return d;
  };

  return (
    <span className={className ? `mc-spark ${className}` : 'mc-spark'} role="img" aria-label={label}>
      <svg width={width} height={height} aria-hidden="true" className="mc-spark-svg">
        {isNum(target) && <line className="mc-spark-tgt" x1={0} x2={width} y1={y(target)} y2={y(target)} />}
        {variant === 'bars'
          ? values.map((v, i) => {
              if (!isNum(v)) return null;
              const bw = Math.max(1, (width / n) * 0.64);
              const z = y(0);
              const prelim = statuses?.[i] === 'preliminary' || statuses?.[i] === 'forecast';
              return <rect key={i} className={`mc-spark-bar${v < 0 ? ' is-neg' : ''}${prelim ? ' is-prelim' : ''}${i === last ? ' is-last' : ''}`} x={x(i) - bw / 2} y={Math.min(z, y(v))} width={bw} height={Math.max(1, Math.abs(z - y(v)))} />;
            })
          : segments(values).map((s, k) => {
              const cut = firstPrelim > 0 && firstPrelim > s.start && firstPrelim <= s.end ? firstPrelim - 1 : -1;
              if (cut >= 0) {
                return (
                  <g key={k}>
                    <path className="mc-spark-line" d={pathFor(s.start, cut)} />
                    <path className="mc-spark-line is-prelim" d={pathFor(cut, s.end)} />
                  </g>
                );
              }
              return <path key={k} className={`mc-spark-line${firstPrelim >= 0 && s.start >= firstPrelim ? ' is-prelim' : ''}`} d={pathFor(s.start, s.end)} />;
            })}
        {variant === 'line' && last >= 0 && <rect className="mc-spark-dot" x={x(last) - 2} y={y(values[last] as number) - 2} width={4} height={4} />}
      </svg>
    </span>
  );
}
