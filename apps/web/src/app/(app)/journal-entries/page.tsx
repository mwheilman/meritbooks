import { PageHeader } from '@/components/ui';
import { JournalEntryList } from './je-list';

export default function JournalEntriesPage() {
  return (
    <>
      <PageHeader
        title="Journal Entries"
        description="Create, review, and post manual journal entries"
        breadcrumbs={[
          { label: 'Financial', href: '#' },
          { label: 'Journal Entries' },
        ]}
        actions={
          <button className="btn-primary btn-sm">New Journal Entry</button>
        }
      />
      <JournalEntryList />
    </>
  );
}
