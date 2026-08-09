import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PageHeader } from '@/components/ui';
import { ExpensesClient } from './expenses-client';
import { ExpensesTabs } from './expenses-tabs';

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
        title="Expenses & Cards"
        description="Employee expense reports — build from receipts, submit, approve, reimburse, and reconcile corporate-card charges."
      />
      <div className="mb-6">
        <ExpensesTabs />
      </div>
      <ExpensesClient />
    </>
  );
}
