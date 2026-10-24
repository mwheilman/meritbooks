/**
 * BulletChart — actual vs target (and budget) against qualitative bands
 * (Stephen Few). A thin Midnight bar is the actual; the Electric tick is the
 * target; an outlined tick is the budget; grey bands are poor / fair / good,
 * flipped for lower-is-better metrics. Server-renderable (percent geometry).
 */
import { formatValue } from './core/format';
import { extent } from './core/scale';
import { summarizeBullet } from './core/summary';
import type { ChartTable } from './core/table';
import type { ChartUnit, MetricDirection, Value } from './core/types';

export interface BulletItem {
  key: string;
  label: string;
  sub?: string;
  actual: Value;
  target: number;
  budget?: Value;
  /** Band edges in the metric's unit: [poor→fair, fair→good] (higher-is-better reading). */
  bands?: [number, number];
  unit: ChartUnit;
  direction: MetricDirection;
}

export interface BulletChartProps {
  items: ReadonlyArray<BulletItem>;
  targetLabel?: string;
  onDrill?: (key: string) => void;
}

function isNum(v: Value | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

export function bulletTable(items: ReadonlyArray<BulletItem>, caption: string, targetLabel = 'Target'): ChartTable {
  return {
    caption,
    columns: [
      { key: 'item', label: 'Measure' },
      { key: 'actual', label: 'Actual' },
      { key: 'target', label: targetLabel },
      { key: 'att', label: '% of target', unit: 'percent' },
    ],
    rows: items.map((i) => ({ key: i.key, cells: [i.label, formatValue(i.actual, i.unit), formatValue(i.target, i.unit), isNum(i.actual) && i.target !== 0 ? i.actual / i.target : null] })),
  };
}

export function BulletChart({ items, targetLabel = 'Target', onDrill }: BulletChartProps) {
  return (
    <ul className="mc-bullets">
      {items.map((it) => {
        const e = extent([it.actual, it.target, it.budget ?? null, ...(it.bands ?? [])]) ?? [0, 1];
        const lo = Math.min(0, e[0]);
        const hi = Math.max(0, e[1]) * 1.12 || 1;
        const pct = (v: number) => `${(((v - lo) / (hi - lo)) * 100).toFixed(2)}%`;
        const w = (a: number, b: number) => `${((Math.abs(b - a) / (hi - lo)) * 100).toFixed(2)}%`;
        const [b1, b2] = it.bands ?? [it.target * 0.8, it.target];
        const flip = it.direction === 'lower_is_better';
        const sentence = summarizeBullet(it.label, it.actual, it.target, it.unit, it.direction);
        const ahead = isNum(it.actual) && (flip ? it.actual <= it.target : it.actual >= it.target);
        const Row = onDrill ? 'button' : 'div';
        return (
          <li key={it.key}>
            <Row className={`mc-bullet${onDrill ? ' is-link' : ''}`} {...(onDrill ? { type: 'button' as const, onClick: () => onDrill(it.key) } : {})} aria-label={sentence}>
              <span className="mc-bullet-l">
                <span className="l1">{it.label}</span>
                {it.sub && <span className="l2">{it.sub}</span>}
              </span>
              <svg className="mc-bullet-svg" width="100%" height="28" aria-hidden="true">
                <rect className={flip ? 'mc-band-g' : 'mc-band-p'} x="0" y="2" width={pct(b1)} height="24" />
                <rect className="mc-band-f" x={pct(b1)} y="2" width={w(b1, b2)} height="24" />
                <rect className={flip ? 'mc-band-p' : 'mc-band-g'} x={pct(b2)} y="2" width={`calc(100% - ${pct(b2)})`} height="24" />
                {isNum(it.budget) && <rect className="mc-bullet-bud" x={pct(it.budget)} y="4" width="3" height="20" transform="translate(-1.5 0)" />}
                {isNum(it.actual) && <rect className="mc-bullet-act" x={pct(Math.min(0, it.actual))} y="10" width={w(0, it.actual)} height="8" />}
                {lo < 0 && <rect className="mc-bullet-zero" x={pct(0)} y="2" width="1" height="24" />}
                <rect className="mc-bullet-tgt" x={pct(it.target)} y="0" width="3" height="28" transform="translate(-1.5 0)" />
              </svg>
              <span className="mc-bullet-v tnum">
                <b>{formatValue(it.actual, it.unit, { compact: it.unit === 'money' })}</b>
                <span className={ahead ? 'pos' : 'neg'}>
                  {isNum(it.actual) && it.unit === 'money' && it.direction === 'higher_is_better' && it.target > 0
                    ? `${formatValue(it.actual / it.target, 'percent', { decimals: 0 })} of `
                    : `${ahead ? 'ahead of' : 'behind'} `}
                  {targetLabel.toLowerCase()} {formatValue(it.target, it.unit, { compact: it.unit === 'money' })}
                </span>
              </span>
            </Row>
          </li>
        );
      })}
    </ul>
  );
}
