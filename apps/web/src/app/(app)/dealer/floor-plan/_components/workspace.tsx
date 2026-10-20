'use client';

/**
 * Floor-plan workspace: URL-synced tabs (`?tab=`), with live counts on the tabs that
 * hold work (sold out of trust, curtailments, payoffs awaiting release).
 */

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { DealerSummary } from '@/lib/dealer/service/insights';
import { useDealerQuery, type ListPage } from '../../_lib/use-dealer';
import type { FpTxn } from '../_lib/types';
import { TabBar } from './bits';
import { PositionsTab } from './positions-tab';
import { SotTab } from './sot-tab';
import { NotesTab } from './notes-tab';
import { CurtailmentsTab } from './curtailments-tab';
import { PayoffsTab } from './payoffs-tab';
import { InterestTab } from './interest-tab';
import { SetupTab } from './setup-tab';

export const FLOOR_TABS = ['positions', 'sot', 'notes', 'curtailments', 'payoffs', 'interest', 'setup'] as const;
export type FloorTab = (typeof FLOOR_TABS)[number];

function isTab(v: string | null): v is FloorTab {
  return !!v && (FLOOR_TABS as readonly string[]).includes(v);
}

export function FloorPlanWorkspace() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? '/dealer/floor-plan';
  const raw = sp?.get('tab') ?? null;
  const tab: FloorTab = isTab(raw) ? raw : 'positions';

  const summary = useDealerQuery<DealerSummary>('/api/dealer/summary');
  const payoffCount = useDealerQuery<ListPage<FpTxn>>('/api/dealer/transactions', { txn_type: 'PAYOFF', status: 'PROPOSED', per_page: 1 });

  const go = useCallback(
    (t: FloorTab, filters: Record<string, string> = {}) => {
      const q = new URLSearchParams({ tab: t, ...filters });
      router.replace(`${pathname}?${q.toString()}`, { scroll: false });
    },
    [router, pathname],
  );

  const refetchSummary = summary.refetch;
  const refetchPayoffs = payoffCount.refetch;
  const refreshCounts = useCallback(() => {
    void refetchSummary();
    void refetchPayoffs();
  }, [refetchSummary, refetchPayoffs]);

  const s = summary.data;
  const tabs: Array<{ key: FloorTab; label: string; count?: number | null; alert?: boolean }> = [
    { key: 'positions', label: 'Positions' },
    { key: 'sot', label: 'Sold out of trust', count: s?.sot.count ?? null, alert: (s?.sot.count ?? 0) > 0 },
    { key: 'notes', label: 'Notes' },
    {
      key: 'curtailments',
      label: 'Curtailments',
      count: s ? s.curtailmentsDue14d.count + s.curtailmentsDue14d.missedCount : null,
      alert: (s?.curtailmentsDue14d.missedCount ?? 0) > 0,
    },
    { key: 'payoffs', label: 'Payoffs', count: payoffCount.data?.total ?? null },
    { key: 'interest', label: 'Interest' },
    { key: 'setup', label: 'Lenders & programs' },
  ];

  const params = sp ?? new URLSearchParams();

  return (
    <div>
      <TabBar tabs={tabs} active={tab} onChange={(t) => go(t)} label="Floor plan sections" idPrefix="fp" />
      <div id="fp-panel" role="tabpanel" aria-labelledby={`fp-tab-${tab}`}>
        {tab === 'positions' && <PositionsTab summary={summary.data} isLoading={summary.isLoading} error={summary.error} onRetry={summary.refetch} go={go} />}
        {tab === 'sot' && <SotTab onChanged={refreshCounts} go={go} />}
        {tab === 'notes' && <NotesTab key={params.toString()} initialStatus={params.get('status')} initialLineId={params.get('lineId')} />}
        {tab === 'curtailments' && <CurtailmentsTab key={params.get('status') ?? ''} initialStatus={params.get('status')} onChanged={refreshCounts} />}
        {tab === 'payoffs' && <PayoffsTab onChanged={refreshCounts} />}
        {tab === 'interest' && <InterestTab />}
        {tab === 'setup' && <SetupTab onChanged={refreshCounts} />}
      </div>
    </div>
  );
}

export type GoTab = (t: FloorTab, filters?: Record<string, string>) => void;
