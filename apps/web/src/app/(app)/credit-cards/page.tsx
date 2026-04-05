import { PageHeader } from '@/components/ui';
import { CreditCardFeed } from './credit-card-feed';

export default function CreditCardsPage() {
  return (
    <>
      <PageHeader
        title="Credit Cards"
        description="Transaction matching with receipt chase tracking"
      />
      <CreditCardFeed />
    </>
  );
}
