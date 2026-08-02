import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PageHeader } from '@/components/ui';
import { ExpensePolicyClient } from './policy-client';

export const dynamic = 'force-dynamic';

export default async function ExpensePolicyPage() {
  // PAGE-LEVEL RBAC: compiling/activating an expense policy is a financial control
  // action (it governs what expenses may be submitted and how they route for
  // approval), so it sits behind the receipts-approve grant. Fails closed.
  await requirePagePermission('receipts', 'approve');
  return (
    <>
      <PageHeader
        title="Expense Policy"
        description="Drop your written expense policy — AI compiles it into a structured, versioned ruleset you review and activate. A deterministic engine then enforces it on every expense."
      />
      <ExpensePolicyClient />
    </>
  );
}
