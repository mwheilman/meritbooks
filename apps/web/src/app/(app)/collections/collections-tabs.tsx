'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { LayoutList, Target } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { CollectionsWorkflow } from './collections-workflow';
import { CollectionsDashboard } from '../invoices/collections/collections-dashboard';

// Unified Collections. Merges the two prior implementations into one page:
//   Aging Buckets  → the AR-aging / DSO worklist (formerly /invoices/collections)
//   Risk & Cadence → the risk-scored dunning worklist with pay-date prediction and
//                    promise-to-pay tracking (formerly /collections)
// Each child renders `embedded` so this shell owns the page header + tab chrome.

type TabKey = 'aging' | 'risk';

const TABS: { key: TabKey; label: string; icon: typeof Target }[] = [
  { key: 'aging', label: 'Aging Buckets', icon: LayoutList },
  { key: 'risk', label: 'Risk & Cadence', icon: Target },
];

function TabBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-brand-500 text-white' : 'text-slate-400 hover:text-slate-200'
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function CollectionsTabs() {
  const [tab, setTab] = useState<TabKey>('aging');

  // Deep-link support: /collections?tab=risk (or ?tab=aging). Also the target for
  // the retired /invoices/collections redirect.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get('tab');
    if (t && TABS.some((x) => x.key === t)) setTab(t as TabKey);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', url.toString());
  }, [tab]);

  return (
    <div className="p-6">
      <PageHeader
        title="Collections"
        description="Chase overdue AR two ways — by aging bucket and DSO, or by risk score with an escalating dunning cadence and pay-date prediction. AI drafts every notice; you approve each send."
        actions={
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-surface-900 p-1">
            {TABS.map(({ key, label, icon: Icon }) => (
              <TabBtn key={key} active={tab === key} onClick={() => setTab(key)} icon={<Icon size={14} />}>
                {label}
              </TabBtn>
            ))}
          </div>
        }
      />

      <div className="mt-6">
        {tab === 'aging' ? <CollectionsDashboard embedded /> : <CollectionsWorkflow embedded />}
      </div>
    </div>
  );
}
