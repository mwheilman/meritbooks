import { Suspense } from 'react';
import { PageHeader } from '@/components/ui';
import { BudgetsTabs } from './budgets-tabs';

export const metadata = { title: 'Budgets' };

export default function BudgetsPage() {
  return (
    <>
      <PageHeader
        title="Budgets & Planning"
        description="Versioned company and department budgets: owners draft their departments, finance reviews and approves, and every department gets budget vs actual and bridges against the ledger."
      />
      <Suspense fallback={null}>
        <BudgetsTabs />
      </Suspense>
    </>
  );
}
