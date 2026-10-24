/**
 * ThresholdGauge — covenant headroom on a linear track (square geometry; no
 * dial). Zones: compliant (clear) · watch (ochre wash, within the cushion) ·
 * breach (hatched brick). Midnight marker = measured; outlined = projected.
 * Status is a pip shape + word. `kind`: 'max' (Debt/EBITDA ≤ 3.5x) or 'min'
 * (DSCR ≥ 1.25x). Server-renderable (percent geometry).
 */
import { Pip } from '@meritbooks/merit-ui';
import { formatValue } from './core/format';
import { fillStyle } from './core/parts';
import { summarizeThreshold } from './core/summary';
import type { ChartUnit, Value } from './core/types';

export interface ThresholdGaugeProps {
  label: string;
  value: Value;
  threshold: number;
  kind: 'max' | 'min';
  unit: ChartUnit;
  /** Cushion that counts as "watch", as a fraction of the threshold (default 0.10). */
  watch?: number;
  projected?: Value;
  projectedLabel?: string;
  /** Track end (default: computed). */
  domainMax?: number;
  period?: string;
  className?: string;
}

function isNum(v: Value | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

export type CovenantState = 'compliant' | 'watch' | 'breach' | 'unknown';

export function covenantState(value: Value, threshold: number, kind: 'max' | 'min', watch = 0.1): CovenantState {
  if (!isNum(value)) return 'unknown';
  if (kind === 'max') {
    if (value > threshold) return 'breach';
    if (value > threshold * (1 - watch)) return 'watch';
    return 'compliant';
  }
  if (value < threshold) return 'breach';
  if (value < threshold * (1 + watch)) return 'watch';
  return 'compliant';
}

export function ThresholdGauge({ label, value, threshold, kind, unit, watch = 0.1, projected, projectedLabel = 'Projected', domainMax, period, className }: ThresholdGaugeProps) {
  const hi = domainMax ?? (Math.max(threshold * 1.6, (isNum(value) ? value : 0) * 1.15, (isNum(projected) ? projected : 0) * 1.15) || 1);
  // A minimum covenant's track starts near the line (not at 0), so the breach
  // zone doesn't swallow the gauge; a maximum covenant starts at 0.
  const lo = kind === 'min' ? Math.max(0, Math.min(threshold * 0.6, (isNum(value) ? value : threshold) * 0.9, (isNum(projected) ? projected : threshold) * 0.9)) : 0;
  const span = hi - lo || 1;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / span) * 100)).toFixed(2)}%`;
  const wid = (a: number, b: number) => `${Math.max(0, ((Math.min(hi, b) - Math.max(lo, a)) / span) * 100).toFixed(2)}%`;
  const st = covenantState(value, threshold, kind, watch);
  const pst = isNum(projected) ? covenantState(projected, threshold, kind, watch) : null;
  const sentence = summarizeThreshold(label, value, threshold, kind, unit);
  const watchEdge = kind === 'max' ? threshold * (1 - watch) : threshold * (1 + watch);
  const word = st === 'breach' ? 'Breach' : st === 'watch' ? 'Watch' : st === 'compliant' ? 'Compliant' : 'Not measured';
  const pip = st === 'breach' ? 'overdue' : st === 'watch' ? 'risk' : st === 'compliant' ? 'ready' : 'track';
  return (
    <div className={className ? `mc-gauge ${className}` : 'mc-gauge'} role="img" aria-label={`${sentence}${pst ? ` ${projectedLabel}: ${formatValue(projected ?? null, unit)} (${pst}).` : ''}`}>
      <div className="mc-gauge-top">
        <span className="mc-gauge-l">{label}</span>
        <span className={`status status--${st === 'breach' ? 'overdue' : st === 'watch' ? 'risk' : st === 'compliant' ? 'ready' : 'track'}`}>
          <Pip kind={pip} />
          {word}
        </span>
      </div>
      <div className="mc-gauge-fig">
        <b className="tnum">{formatValue(value, unit)}</b>
        <span>
          {kind === 'max' ? 'Max' : 'Min'} {formatValue(threshold, unit)}
          {period ? ` · ${period}` : ''}
        </span>
      </div>
      <svg className="mc-gauge-svg" width="100%" height="40" aria-hidden="true">
        <defs>
          <pattern id={`g-neg-${label.replace(/[^a-z0-9]/gi, '')}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect className="mc-pt-neg-bg" width="5" height="5" />
            <rect className="mc-pt-neg-fg" width="1.6" height="5" />
          </pattern>
        </defs>
        {kind === 'max' ? (
          <>
            <rect className="mc-zone-ok" x="0" y="14" width={pos(watchEdge)} height="12" />
            <rect className="mc-zone-watch" x={pos(watchEdge)} y="14" width={wid(watchEdge, threshold)} height="12" />
            <rect className="mc-zone-breach" x={pos(threshold)} y="14" width={wid(threshold, hi)} height="12" style={fillStyle(`url(#g-neg-${label.replace(/[^a-z0-9]/gi, '')})`)} />
          </>
        ) : (
          <>
            <rect className="mc-zone-breach" x="0" y="14" width={pos(threshold)} height="12" style={fillStyle(`url(#g-neg-${label.replace(/[^a-z0-9]/gi, '')})`)} />
            <rect className="mc-zone-watch" x={pos(threshold)} y="14" width={wid(threshold, watchEdge)} height="12" />
            <rect className="mc-zone-ok" x={pos(watchEdge)} y="14" width={wid(watchEdge, hi)} height="12" />
          </>
        )}
        <rect className="mc-gauge-thr" x={pos(threshold)} y="8" width="2" height="24" transform="translate(-1 0)" />
        {isNum(projected) && <rect className="mc-gauge-proj" x={pos(projected)} y="13" width="10" height="14" transform="translate(-5 0)" />}
        {isNum(value) && <rect className="mc-gauge-mark" x={pos(value)} y="11" width="10" height="18" transform="translate(-5 0)" />}
      </svg>
      <p className="mc-gauge-s">{sentence}{pst && isNum(projected) ? ` ${projectedLabel} ${formatValue(projected, unit)}${pst === 'breach' ? ' would breach.' : '.'}` : ''}</p>
    </div>
  );
}
