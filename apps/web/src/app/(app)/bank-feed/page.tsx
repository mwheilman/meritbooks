import { PageHeader } from '@/components/ui';
import { BankFeedContent } from './bank-feed-content';

export default function BankFeedPage() {
  return (
    <>
      <PageHeader
        title="Bank Feed"
        description="AI-categorized transactions awaiting review"
      />
      <BankFeedContent />
    </>
  );
}
