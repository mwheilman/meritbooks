import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PageHeader } from '@/components/ui';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { ExpensesClient } from './expenses-client';
import { ExpensesTabs } from './expenses-tabs';

export const metadata = { title: 'Expenses' };

export const dynamic = 'force-dynamic';

export default async function ExpensesPage() {
  // PAGE-LEVEL RBAC (identity gate #9). Expense reports move money (reimbursement)
  // and carry segregation of duties, so only roles that may view the receipts /
  // transaction-processing surface reach this screen; everyone else is redirected.
  // Fails closed. Submit/approve/reimburse routes enforce their own guards + SoD.
  await requirePagePermission('receipts', 'view');
  return (
    <>
      <PageHeader
        eyebrow={['Payables', 'Expenses']}
        title="Expenses & cards"
        description="Employee expense reports: build from receipts, submit, approve, reimburse, and match corporate-card charges."
      />
      <ExpensesTabs />
      <CompanyScopeGuard>
        <ExpensesClient />
      </CompanyScopeGuard>
    </>
  );
}
