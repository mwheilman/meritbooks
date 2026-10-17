import { clsx } from 'clsx';
import { TrendingUp, TrendingDown, Minus, type LucideIcon } from 'lucide-react';

interface MetricCardProps {
  label: string;
  value: string;
  change?: {
    value: string;
    direction: 'up' | 'down' | 'flat';
    label?: string;
  };
  icon?: LucideIcon;
  className?: string;
}

export function MetricCard({ label, value, change, icon: Icon, className }: MetricCardProps) {
  const TrendIcon = change?.direction === 'up'
    ? TrendingUp
    : change?.direction === 'down'
      ? TrendingDown
      : Minus;

  return (
    <div className={clsx('card p-5', className)}>
      <div className="flex items-start justify-between">
        <p className="eyebrow">{label}</p>
        {Icon && (
          <div className="h-8 w-8 rounded-lg bg-brand-500/10 flex items-center justify-center">
            <Icon size={16} className="text-brand-400" />
          </div>
        )}
      </div>
      {/* Standalone KPI = brand "big stat": Syne 700, tabular. Figures inside
          tables/ledgers/forms stay JetBrains Mono (design system §2). */}
      <p className="mt-2 font-display text-[1.75rem] leading-9 font-bold tracking-[-0.02em] text-ink-hi tabular-nums">{value}</p>
      {change && (
        <div className="mt-2 flex items-center gap-1.5">
          <TrendIcon
            size={14}
            className={clsx(
              change.direction === 'up' && 'text-emerald-400',
              change.direction === 'down' && 'text-red-400',
              change.direction === 'flat' && 'text-slate-500'
            )}
          />
          <span
            className={clsx(
              'text-xs font-medium',
              change.direction === 'up' && 'text-emerald-400',
              change.direction === 'down' && 'text-red-400',
              change.direction === 'flat' && 'text-slate-500'
            )}
          >
            {change.value}
          </span>
          {change.label && (
            <span className="text-xs text-slate-500">{change.label}</span>
          )}
        </div>
      )}
    </div>
  );
}
