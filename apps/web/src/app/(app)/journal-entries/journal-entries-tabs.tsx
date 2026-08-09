'use client';

import { BookOpen, Repeat } from 'lucide-react';
import { SectionTabs, useSectionTab } from '../_components/section-tabs';
import { JournalEntriesClient } from './je-client';
import { RecurringJeView } from '../recurring-journal-entries/recurring-je-view';

const TABS = ['entries', 'recurring'] as const;

export function JournalEntriesTabs() {
  const [tab, setTab] = useSectionTab(TABS, 'entries');

  return (
    <div className="space-y-6">
      <SectionTabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'entries', label: 'Journal Entries', icon: <BookOpen size={14} /> },
          { id: 'recurring', label: 'Recurring', icon: <Repeat size={14} /> },
        ]}
      />

      {tab === 'entries' && <JournalEntriesClient />}
      {tab === 'recurring' && <RecurringJeView />}
    </div>
  );
}
