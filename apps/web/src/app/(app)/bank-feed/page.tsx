import { Suspense } from 'react';
import { BankFeedTabs } from './bank-feed-tabs';

export default function BankFeedPage() {
  // Suspense wraps the client tab shell because it reads the initial tab from `?tab=`
  // via useSearchParams (Next 14 requirement).
  return (
    <Suspense fallback={null}>
      <BankFeedTabs />
    </Suspense>
  );
}
