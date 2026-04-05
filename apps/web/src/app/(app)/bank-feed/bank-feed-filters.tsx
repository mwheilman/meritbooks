'use client';

import { useState } from 'react';
import { Filter, Search } from 'lucide-react';
import { clsx } from 'clsx';

const STATUS_TABS = [
  { key: 'all', label: 'All', count: 47 },
  { key: 'pending', label: 'Pending', count: 23 },
  { key: 'categorized', label: 'Categorized', count: 18 },
  { key: 'flagged', label: 'Flagged', count: 6 },
] as const;

export function BankFeedFilters() {
  const [activeTab, setActiveTab] = useState<string>('all');
  const [search, setSearch] = useState('');

  return (
    <div className="mb-4 space-y-3">
      {/* Status tabs */}
      <div className="flex items-center gap-1 p-1 rounded-lg bg-surface-900 border border-slate-800 w-fit">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
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
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Search + filters row */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
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
