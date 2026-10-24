/**
 * ChangeChip — arrow + figure + WORD + colour (never colour alone).
 * "▲ 13.1% improvement vs Aug 2025" · "▼ 2.3 pts erosion vs budget" · "n/m vs Aug 2025".
 * The word comes from the metric's direction: revenue up is an improvement,
 * DSO up is an erosion.
 */
import { compare, formatDelta, formatValue, type Change } from './core/format';
import type { ChartUnit, MetricDirection } from './core/types';

export interface ChangeChipProps {
  current: number;
  base: number;
  unit: ChartUnit;
  direction: MetricDirection;
  /** "Aug 2025", "budget", "prior month". */
  baseLabel: string;
  /** Show the relative change (%) when meaningful; else the absolute delta. Default true. */
  relative?: boolean;
  /** Plain (no wash) for dense rows. */
  quiet?: boolean;
  className?: string;
}

export function changeText(c: Change, unit: ChartUnit, relative: boolean): string {
  if (c.move === 'flat') return unit === 'percent' ? '0.0 pts' : '0.0%';
  if (unit === 'percent') return formatDelta(c.delta, unit).replace(/^[+−]/, '');
  if (relative && c.rel !== null) return formatValue(Math.abs(c.rel), 'percent');
  return formatValue(Math.abs(c.delta), unit, { compact: true });
}

export function ChangeChip({ current, base, unit, direction, baseLabel, relative = true, quiet, className }: ChangeChipProps) {
  const c = compare(current, base, direction, unit);
  const nm = relative && unit !== 'percent' && c.rel === null && c.move !== 'flat';
  const arrow = c.move === 'up' ? '▲' : c.move === 'down' ? '▼' : '–';
  const word = c.tone === 'improvement' ? 'improvement' : c.tone === 'erosion' ? 'erosion' : c.tone === 'flat' ? 'flat' : c.move === 'up' ? 'up' : 'down';
  const tone = c.tone === 'improvement' ? 'pos' : c.tone === 'erosion' ? 'neg' : 'neutral';
  const figure = nm ? formatValue(c.delta, unit, { compact: true, delta: true }) : changeText(c, unit, relative);
  const label = `${c.move === 'flat' ? 'Flat' : `${c.move === 'up' ? 'Up' : 'Down'} ${figure}`}${c.tone === 'improvement' || c.tone === 'erosion' ? `, ${c.tone}` : ''}, versus ${baseLabel}`;
  return (
    <span className={['mc-chg', `mc-chg--${tone}`, quiet ? 'mc-chg--quiet' : '', className ?? ''].filter(Boolean).join(' ')} aria-label={label} role="img">
      <span className="mc-chg-a" aria-hidden="true">
        {arrow}
      </span>
      <span className="mc-chg-v">{figure}</span>
      {!quiet && c.move !== 'flat' && <span className="mc-chg-w">{word}</span>}
      <span className="mc-chg-b">vs {baseLabel}</span>
    </span>
  );
}
