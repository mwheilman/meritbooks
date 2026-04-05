import { PageHeader } from '@/components/ui';
import { BankFeedContent } from './bank-feed-content';

export default function BankFeedPage() {
  return (
    <>
      <PageHeader
        title="Bank Feed"
        description="AI-categorized transactions awaiting review"
        actions={
          <div className="flex items-center gap-2">
            <button className="btn-secondary btn-sm">Sync Now</button>
          </div>
        }
      />
      <BankFeedContent />
    </>
  );
}
