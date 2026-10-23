'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Tabs } from '@meritbooks/merit-ui';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { RecognitionPolicyCard } from '@/components/rev-rec/recognition-policy-card';
import { RevRecMonthEnd } from './rev-rec-month-end';
import { RevRecReports } from './rev-rec-reports';

type Tab = 'month-end' | 'policy' | 'reports';
const TABS: ReadonlyArray<{ value: Tab; label: string; panelId: string }> = [
  { value: 'month-end', label: 'Month-end entry', panelId: 'rr-panel-month-end' },
  { value: 'policy', label: 'How you recognize revenue', panelId: 'rr-panel-policy' },
  { value: 'reports', label: 'Reports', panelId: 'rr-panel-reports' },
];
const isTab = (v: string | null): v is Tab => v === 'month-end' || v === 'policy' || v === 'reports';

export function RevRecTabs() {
  const params = useSearchParams();
  const router = useRouter();
  const initial = params?.get('tab') ?? null;
  const [tab, setTab] = useState<Tab>(isTab(initial) ? initial : 'month-end');
  useEffect(() => {
    if (isTab(initial)) setTab(initial);
  }, [initial]);

  const change = (t: Tab) => {
    setTab(t);
    router.replace(`/rev-rec?tab=${t}`, { scroll: false });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Tabs<Tab> aria-label="Revenue recognition" items={TABS} value={tab} onChange={change} />
      <div role="tabpanel" id={TABS.find((x) => x.value === tab)?.panelId}>
        {tab === 'month-end' ? (
          // Posting writes into ONE company's books — scope-guarded.
          <CompanyScopeGuard>
            <RevRecMonthEnd />
          </CompanyScopeGuard>
        ) : tab === 'policy' ? (
          <CompanyScopeGuard title="Pick a company to set its revenue policy">
            <RecognitionPolicyCard />
          </CompanyScopeGuard>
        ) : (
          // Reports are read-only and allow the consolidated ("All") view.
          <RevRecReports />
        )}
      </div>
    </div>
  );
}
