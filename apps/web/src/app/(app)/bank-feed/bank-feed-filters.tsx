'use client';

import { Filter, Search } from 'lucide-react';
import { clsx } from 'clsx';
import { formatMoney } from '@meritbooks/shared';
import type { BankFeedStatusCounts } from '@meritbooks/shared';

interface BankFeedFiltersProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  counts: Record<string, BankFeedStatusCounts> | null;
}

const TAB_CONFIG = [
  { key: 'all', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'CATEGORIZED', label: 'Categorized' },
  { key: 'FLAGGED', label: 'Flagged' },
] as const;

export function BankFeedFilters({ activeTab, onTabChange, search, onSearchChange, counts }: BankFeedFiltersProps) {
  return (
    <div className="mb-4 space-y-3">
      {/* Status tabs */}
      <div className="flex items-center gap-1 p-1 rounded-lg bg-surface-900 border border-slate-800 w-fit">
        {TAB_CONFIG.map((tab) => {
          const stats = counts?.[tab.key] ?? null;
          return (
            <button
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors',
                activeTab === tab.key
                  ? 'bg-slate-800 text-white font-medium'
                  : 'text-slate-400 hover:text-slate-300'
              )}
            >
              <span>{tab.label}</span>
              <span className={clsx(
                'text-2xs font-mono tabular-nums',
                activeTab === tab.key ? 'text-brand-400' : 'text-slate-600'
              )}>
                {stats
                  ? `${stats.count} · ${formatMoney(stats.amount_cents, { compact: true })}`
                  : '--'}
              </span>
            </button>
          );
        })}
      </div>

      {/* Search + filters row */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search by vendor, amount, or description..."
            className="input pl-9"
          />
        </div>
        <button className="btn-ghost btn-sm">
          <Filter size={14} />
          <span>Filters</span>
        </button>
      </div>
    </div>
  );
}
