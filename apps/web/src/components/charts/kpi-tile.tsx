/**
 * KpiTile — value, status light, change chip, sparkline, target (Fathom-class
 * scorecard, E-REPORTING U1). Status is a SHAPE + a WORD (kit pips), never
 * colour alone. Refuses to invent: an unavailable metric shows its reason
 * where the number would be. The whole tile is the drill target.
 */
import { Pip, type PipKind } from '@meritbooks/merit-ui';
import { ChangeChip } from './change-chip';
import { UNAVAILABLE_COPY } from './chart-state';
import { formatValue } from './core/format';
import type { ChartUnit, MetricDirection, PeriodStatus, UnavailableReason, Value } from './core/types';
import { Sparkline } from './sparkline';

export type KpiStatus = 'on_target' | 'watch' | 'off_target' | 'none';

const STATUS: Record<Exclude<KpiStatus, 'none'>, { pip: PipKind; word: string; cls: string }> = {
  on_target: { pip: 'ready', word: 'On target', cls: 'status--ready' },
  watch: { pip: 'risk', word: 'Watch', cls: 'status--risk' },
  off_target: { pip: 'overdue', word: 'Off target', cls: 'status--overdue' },
};

export interface KpiTileProps {
  label: string;
  value: Value;
  unit: ChartUnit;
  direction: MetricDirection;
  /** "YTD Aug 2026", "TTM", "Aug 2026". */
  period?: string;
  status?: KpiStatus;
  /** Change versus a base. */
  change?: { base: number; baseLabel: string };
  /** Target / budget for the period. */
  target?: number | null;
  targetLabel?: string;
  /** Trend for the sparkline (oldest → newest). */
  series?: ReadonlyArray<Value>;
  seriesLabels?: ReadonlyArray<string>;
  seriesStatuses?: ReadonlyArray<PeriodStatus | undefined>;
  /** Shown instead of the value (e.g. "not_enough_history"). */
  unavailable?: UnavailableReason;
  unavailableDetail?: string;
  /** Preliminary period marker beside the period. */
  preliminary?: boolean;
  onDrill?: () => void;
  href?: string;
  className?: string;
}

export function KpiTile({
  label,
  value,
  unit,
  direction,
  period,
  status = 'none',
  change,
  target,
  targetLabel = 'Target',
  series,
  seriesLabels,
  seriesStatuses,
  unavailable,
  unavailableDetail,
  preliminary,
  onDrill,
  href,
  className,
}: KpiTileProps) {
  const st = status !== 'none' ? STATUS[status] : null;
  const na = unavailable ? UNAVAILABLE_COPY[unavailable] : null;
  const body = (
    <>
      <span className="mc-kpi-top">
        <span className="mc-kpi-l">{label}</span>
        {st && (
          <span className={`status ${st.cls} mc-kpi-st`}>
            <Pip kind={st.pip} />
            {st.word}
          </span>
        )}
      </span>
      {na ? (
        <span className="mc-kpi-na">
          <span className="mc-kpi-na-t">{na.title}</span>
          <span className="mc-kpi-na-b">{unavailableDetail ?? na.body}</span>
        </span>
      ) : (
        <>
          <span className="mc-kpi-v tnum">{formatValue(value, unit, { compact: unit === 'money' })}</span>
          {change && value !== null && <ChangeChip current={value} base={change.base} unit={unit} direction={direction} baseLabel={change.baseLabel} className="mc-kpi-chg" />}
        </>
      )}
      {series && series.length > 1 && (
        <span className="mc-kpi-spark">
          <Sparkline values={series} unit={unit} metric={label} labels={seriesLabels} statuses={seriesStatuses} width={160} height={28} target={target ?? null} />
        </span>
      )}
      <span className="mc-kpi-foot">
        {period && (
          <span>
            {period}
            {preliminary && <abbr className="mc-mk" title="Preliminary — the period is not closed">P</abbr>}
          </span>
        )}
        {target !== null && target !== undefined && (
          <span>
            {targetLabel} {formatValue(target, unit, { compact: unit === 'money' })}
          </span>
        )}
      </span>
    </>
  );
  const cls = ['mc-kpi', onDrill || href ? 'is-link' : '', st ? `mc-kpi--${status}` : '', className ?? ''].filter(Boolean).join(' ');
  if (href)
    return (
      <a className={cls} href={href}>
        {body}
      </a>
    );
  if (onDrill)
    return (
      <button type="button" className={cls} onClick={onDrill}>
        {body}
      </button>
    );
  return <div className={cls}>{body}</div>;
}
