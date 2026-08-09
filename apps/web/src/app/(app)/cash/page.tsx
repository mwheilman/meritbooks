import { Suspense } from 'react';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { CashTabs } from './cash-tabs';

export default function CashPage() {
  // COMPANY-SCOPE CONTROL: cash position/forecast is per company.
  // Suspense wraps the client tab shell because it reads the initial tab from `?tab=`
  // via useSearchParams (Next 14 requirement).
  return (
    <CompanyScopeGuard>
      <Suspense fallback={null}>
        <CashTabs />
      </Suspense>
    </CompanyScopeGuard>
  );
}
