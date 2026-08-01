import { PageHeader } from '@/components/ui';
import { BudgetsWorkspace } from './budgets-workspace';

export default function BudgetsPage() {
  return (
    <>
      <PageHeader
        title="Budgets & Variance"
        description="Author annual budgets by account and compare against posted GL actuals."
      />
      <BudgetsWorkspace />
    </>
  );
}
