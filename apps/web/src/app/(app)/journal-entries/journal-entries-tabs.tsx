'use client';

import { SectionTabs, useSectionTab } from '../_components/section-tabs';
import { JournalEntriesClient } from './je-client';
import { RecurringJeView } from '../recurring-journal-entries/recurring-je-view';
import s from './je.module.css';

const TABS = ['entries', 'recurring'] as const;

export function JournalEntriesTabs() {
  const [tab, setTab] = useSectionTab(TABS, 'entries');

  return (
    <div className={s.stack}>
      <SectionTabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'entries', label: 'Journal entries' },
          { id: 'recurring', label: 'Recurring' },
        ]}
      />

      {tab === 'entries' && <JournalEntriesClient />}
      {tab === 'recurring' && <RecurringJeView />}
    </div>
  );
}
