'use client';

import { BarChart3, Bot, Zap, TrendingUp } from 'lucide-react';
import { clsx } from 'clsx';
import { Skeleton } from '@/components/ui';
import type { BankFeedMetrics } from '@meritbooks/shared';

interface BankFeedMetricsStripProps {
  metrics: BankFeedMetrics | null;
  isLoading: boolean;
}

export function BankFeedMetricsStrip({ metrics, isLoading }: BankFeedMetricsStripProps) {
  if (isLoading) {
    return (
      <div className="mb-4 flex items-center gap-6 px-4 py-3 rounded-lg bg-surface-900 border border-slate-800">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-5 w-36" />
        ))}
      </div>
    );
  }

  if (!metrics) return null;

  const { total_today, reviewed_today, auto_approved_today, avg_confidence } = metrics;
  const pctReviewed = total_today > 0 ? Math.round((reviewed_today / total_today) * 100) : 0;
  const avgPct = Math.round(avg_confidence * 100);

  return (
    <div className="mb-4 flex items-center gap-6 px-4 py-3 rounded-lg bg-surface-900 border border-slate-800">
      {/* Reviewed today */}
      <div className="flex items-center gap-2">
        <BarChart3 size={14} className="text-slate-500" />
        <span className="text-sm text-slate-400">Reviewed today</span>
        <span className="text-sm font-medium text-white font-mono tabular-nums">
          {reviewed_today}/{total_today}
        </span>
        {total_today > 0 && (
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                className={clsx(
                  'h-full rounded-full transition-all',
                  pctReviewed >= 80 ? 'bg-emerald-500' : pctReviewed >= 50 ? 'bg-amber-500' : 'bg-slate-600'
                )}
                style={{ width: `${pctReviewed}%` }}
              />
            </div>
            <span className="text-2xs font-mono tabular-nums text-slate-500">{pctReviewed}%</span>
          </div>
        )}
      </div>

      <div className="h-4 w-px bg-slate-800" />

      {/* AI auto-approved */}
      <div className="flex items-center gap-2">
        <Zap size={14} className="text-indigo-400" />
        <span className="text-sm text-slate-400">AI auto-approved</span>
        <span className="text-sm font-medium text-white font-mono tabular-nums">{auto_approved_today}</span>
      </div>

      <div className="h-4 w-px bg-slate-800" />

      {/* Avg confidence */}
      <div className="flex items-center gap-2">
        <Bot size={14} className="text-indigo-400" />
        <span className="text-sm text-slate-400">Avg confidence</span>
        <span className={clsx(
          'text-sm font-medium font-mono tabular-nums',
          avgPct >= 85 ? 'text-emerald-400' : avgPct >= 70 ? 'text-amber-400' : 'text-red-400'
        )}>
          {avgPct}%
        </span>
      </div>
    </div>
  );
}
