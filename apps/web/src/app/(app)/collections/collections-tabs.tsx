'use client';

import { useEffect, useState } from 'react';
import { Tabs } from '@meritbooks/merit-ui';
import { PageHeader } from '@/components/ui';
import { CollectionsWorkflow } from './collections-workflow';
import { CollectionsDashboard } from '../invoices/collections/collections-dashboard';

// Unified Collections. Merges the two prior implementations into one page:
//   Aging Buckets  → the AR-aging / DSO worklist (formerly /invoices/collections)
//   Risk & Cadence → the risk-scored dunning worklist with pay-date prediction and
//                    promise-to-pay tracking (formerly /collections)
// Each child renders `embedded` so this shell owns the page header + tab chrome.

type TabKey = 'aging' | 'risk';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'aging', label: 'Aging buckets' },
  { key: 'risk', label: 'Risk & cadence' },
];

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
    <div>
      <PageHeader
        eyebrow={['Receivables', 'Collections']}
        title="Collections"
        description="Chase overdue receivables two ways: by aging bucket and DSO, or by risk score with an escalating notice cadence and a pay-date forecast. AI drafts every notice; you approve each send."
      />

      <Tabs<TabKey>
        aria-label="Collections view"
        className="mb-section-tabs"
        value={tab}
        onChange={setTab}
        items={TABS.map((t) => ({ value: t.key, label: t.label, panelId: `collections-${t.key}` }))}
      />

      <div id={`collections-${tab}`} role="tabpanel">
        {tab === 'aging' ? <CollectionsDashboard embedded /> : <CollectionsWorkflow embedded />}
      </div>
    </div>
  );
}
