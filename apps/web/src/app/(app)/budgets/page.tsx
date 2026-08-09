import { Suspense } from 'react';
import { PageHeader } from '@/components/ui';
import { BudgetsTabs } from './budgets-tabs';

export default function BudgetsPage() {
  return (
    <>
      <PageHeader
        title="Budgets & Planning"
        description="Author annual budgets by account, build them from drivers, and roll them forward against posted GL actuals."
      />
      <Suspense fallback={null}>
        <BudgetsTabs />
      </Suspense>
    </>
  );
}
