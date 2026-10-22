import { Icon } from '@meritbooks/merit-ui';

interface MetricCardProps {
  label: string;
  value: string;
  change?: {
    value: string;
    direction: 'up' | 'down' | 'flat';
    label?: string;
  };
  /** Accepted for compatibility; the suite draws no icon on a figure (kit: no icon KPI strip). */
  icon?: unknown;
  className?: string;
}

const DIRECTION_WORD = { up: 'Up', down: 'Down', flat: 'Flat' } as const;

/**
 * A figure tile on merit-ui (kit `.fig` on a hairline surface): tracked-caps label,
 * the value in DM Sans 600 20 tabular, and its comparison line. The direction is a
 * word plus an arrow, never colour alone, and amounts are never coloured by sign.
 */
export function MetricCard({ label, value, change, className }: MetricCardProps) {
  return (
    <div className={['surface', 'mb-metric', className].filter(Boolean).join(' ')}>
      <div className="fig">
        <span className="fig-l">{label}</span>
        <span className="fig-v fig-v--dense tnum">{value}</span>
        {change && (
          <span className="fig-vs">
            <span className="mb-delta">
              {change.direction !== 'flat' && <Icon name={change.direction === 'up' ? 'up' : 'down'} size={12} />}
              <span className="sr">{DIRECTION_WORD[change.direction]} </span>
              <b className="tnum">{change.value}</b>
            </span>
            {change.label && <span>{change.label}</span>}
          </span>
        )}
      </div>
    </div>
  );
}
