'use client';

import { PageHeader } from '@/components/ui';
import { ListChecks, Gauge, CalendarCheck, TrendingUp } from 'lucide-react';
import { SectionTabs, useSectionTab } from '../_components/section-tabs';
import { CloseOrchestration } from './close-grid';
import { CloseStatusBoard } from '../close-status/close-status-board';
import { YearEndCloseView } from './year-end-view';
import { FluxReview } from './flux-review';

const TABS = ['tasks', 'status', 'flux', 'year-end'] as const;

const DESCRIPTIONS: Record<(typeof TABS)[number], string> = {
  tasks: 'Ordered close task graph per entity — auto-verified from live data, with a blocking hard-close gate',
  status: 'Real-time close readiness across every entity — derived from the live books, not a checklist',
  flux: 'Every material change against your materiality policy, explained and reviewed before the hard close',
  'year-end': 'Roll each entity’s temporary accounts into retained earnings at fiscal year-end',
};

export function CloseTabs() {
  const [tab, setTab] = useSectionTab(TABS, 'tasks');

  return (
    <>
      <PageHeader
        title="Close"
        description={DESCRIPTIONS[tab]}
        actions={
          <SectionTabs
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'tasks', label: 'Tasks', icon: <ListChecks size={14} /> },
              { id: 'status', label: 'Status', icon: <Gauge size={14} /> },
              { id: 'flux', label: 'Flux review', icon: <TrendingUp size={14} /> },
              { id: 'year-end', label: 'Year-End', icon: <CalendarCheck size={14} /> },
            ]}
          />
        }
      />

      {tab === 'tasks' && <CloseOrchestration />}
      {tab === 'status' && <CloseStatusBoard />}
      {tab === 'flux' && <FluxReview />}
      {tab === 'year-end' && <YearEndCloseView />}
    </>
  );
}
