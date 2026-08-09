import { Suspense } from 'react';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { DebtTabs } from './debt-tabs';

export const metadata = {
  title: 'Debt & Loans',
};

export default function DebtPage() {
  // COMPANY-SCOPE CONTROL: the debt register and its posting are per company.
  // Suspense wraps the client tab shell because it reads the initial tab from `?tab=`
  // via useSearchParams (Next 14 requirement).
  return (
    <CompanyScopeGuard>
      <Suspense fallback={null}>
        <DebtTabs />
      </Suspense>
    </CompanyScopeGuard>
  );
}
