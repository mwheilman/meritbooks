import { Suspense } from 'react';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { BankFeedTabs } from './bank-feed-tabs';

export default function BankFeedPage() {
  // COMPANY-SCOPE CONTROL: bank-feed processing is per company. The guard blocks
  // the consolidated "All" view; the in-page selector then filters within the
  // active company (its default null now inherits the active company via useQuery).
  // Suspense wraps the client tab shell because it reads the initial tab from `?tab=`
  // via useSearchParams (Next 14 requirement).
  return (
    <CompanyScopeGuard>
      <Suspense fallback={null}>
        <BankFeedTabs />
      </Suspense>
    </CompanyScopeGuard>
  );
}
