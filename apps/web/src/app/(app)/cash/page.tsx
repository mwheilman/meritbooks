import { Suspense } from 'react';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { FeedHealthBanner } from '@/components/bank/feed-health-banner';
import { CashTabs } from './cash-tabs';

export const metadata = { title: 'Cash position' };

export default function CashPage() {
  // COMPANY-SCOPE CONTROL: cash position/forecast is per company.
  // Suspense wraps the client tab shell because it reads the initial tab from `?tab=`
  // via useSearchParams (Next 14 requirement).
  return (
    <CompanyScopeGuard>
      <FeedHealthBanner />
      <Suspense fallback={null}>
        <CashTabs />
      </Suspense>
    </CompanyScopeGuard>
  );
}
