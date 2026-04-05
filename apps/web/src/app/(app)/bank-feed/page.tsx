import { PageHeader } from '@/components/ui';
import { BankFeedList } from './bank-feed-list';
import { BankFeedFilters } from './bank-feed-filters';

export default function BankFeedPage() {
  return (
    <>
      <PageHeader
        title="Bank Feed"
        description="AI-categorized transactions awaiting review"
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-secondary btn-sm">Sync Now</button>
            <button className="btn-primary btn-sm">Batch Approve</button>
          </div>
        }
      />
      <BankFeedFilters />
      <BankFeedList />
    </>
  );
}
