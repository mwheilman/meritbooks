import { clsx } from 'clsx';

interface ConfidenceBarProps {
  value: number; // 0-1
  showLabel?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function ConfidenceBar({ value, showLabel = true, size = 'sm', className }: ConfidenceBarProps) {
  const pct = Math.round(value * 100);
  const color = pct >= 85
    ? 'bg-emerald-500'
    : pct >= 70
      ? 'bg-amber-500'
      : 'bg-red-500';

  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div className={clsx('confidence-bar flex-1', size === 'sm' ? 'h-1.5' : 'h-2')}>
        <div
          className={clsx('confidence-fill', color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {showLabel && (
        <span className={clsx(
          'font-mono tabular-nums',
          size === 'sm' ? 'text-2xs' : 'text-xs',
          pct >= 85 ? 'text-emerald-400' : pct >= 70 ? 'text-amber-400' : 'text-red-400'
        )}>
          {pct}%
        </span>
      )}
    </div>
  );
}
