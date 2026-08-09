import { Suspense } from 'react';
import { CashTabs } from './cash-tabs';

export default function CashPage() {
  // Suspense wraps the client tab shell because it reads the initial tab from `?tab=`
  // via useSearchParams (Next 14 requirement).
  return (
    <Suspense fallback={null}>
      <CashTabs />
    </Suspense>
  );
}
