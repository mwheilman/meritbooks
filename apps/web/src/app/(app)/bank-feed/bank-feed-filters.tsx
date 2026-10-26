'use client';

/**
 * Search + status tabs. Each status tab carries its count and its dollar total
 * ("Pending 41 · $12.3K"); the search is debounced by the caller and focuses on "/".
 */

import type { ReactNode } from 'react';
import { Search, Tabs, type TabItem } from '@meritbooks/merit-ui';
import { formatMoney } from '@meritbooks/shared';
import type { BankFeedStatusCounts } from '@meritbooks/shared';
import styles from './bank-feed.module.css';

interface BankFeedFiltersProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  counts: Record<string, BankFeedStatusCounts> | null;
  /** Page verbs shown at the right of the search row (Refresh, Import, AI categorize). */
  actions?: ReactNode;
}

const TAB_CONFIG = [
  { key: 'all', label: 'All' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'CATEGORIZED', label: 'Categorized' },
  { key: 'FLAGGED', label: 'Flagged' },
  // Posted lines: open one to view its split or "Reverse & edit" (FPB-bank-feed-splits).
  { key: 'POSTED', label: 'Posted' },
] as const;

export function BankFeedFilters({ activeTab, onTabChange, search, onSearchChange, counts, actions }: BankFeedFiltersProps) {
  const items: TabItem<string>[] = TAB_CONFIG.map((tab) => {
    const stats = counts?.[tab.key] ?? null;
    return {
      value: tab.key,
      label: tab.label,
      count: stats
        ? `${stats.count.toLocaleString()} · ${formatMoney(stats.amount_cents, { compact: true })}`
        : tab.key === 'POSTED'
          ? undefined
          : '—',
    };
  });

  return (
    <>
      <div className={styles.toolbar}>
        <Search
          className={styles.search}
          slashToFocus
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Vendor, amount or description"
          aria-label="Search bank transactions"
        />
        <span className="sp" />
        {actions}
      </div>

      <Tabs<string>
        className={styles.statusTabs}
        aria-label="Status"
        value={activeTab}
        onChange={onTabChange}
        items={items}
      />
    </>
  );
}
