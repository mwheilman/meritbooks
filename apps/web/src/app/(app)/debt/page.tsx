import { Suspense } from 'react';
import { DebtTabs } from './debt-tabs';

export const metadata = {
  title: 'Debt & Loans',
};

export default function DebtPage() {
  // Suspense wraps the client tab shell because it reads the initial tab from `?tab=`
  // via useSearchParams (Next 14 requirement).
  return (
    <Suspense fallback={null}>
      <DebtTabs />
    </Suspense>
  );
}
