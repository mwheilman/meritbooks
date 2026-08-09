'use client';

import { PageHeader } from '@/components/ui';
import { ListChecks, Gauge, CalendarCheck } from 'lucide-react';
import { SectionTabs, useSectionTab } from '../_components/section-tabs';
import { CloseOrchestration } from './close-grid';
import { CloseStatusBoard } from '../close-status/close-status-board';
import { YearEndCloseView } from './year-end-view';

const TABS = ['tasks', 'status', 'year-end'] as const;

const DESCRIPTIONS: Record<(typeof TABS)[number], string> = {
  tasks: 'Ordered close task graph per entity — auto-verified from live data, with a blocking hard-close gate',
  status: 'Real-time close readiness across every entity — derived from the live books, not a checklist',
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
              { id: 'year-end', label: 'Year-End', icon: <CalendarCheck size={14} /> },
            ]}
          />
        }
      />

      {tab === 'tasks' && <CloseOrchestration />}
      {tab === 'status' && <CloseStatusBoard />}
      {tab === 'year-end' && <YearEndCloseView />}
    </>
  );
}
