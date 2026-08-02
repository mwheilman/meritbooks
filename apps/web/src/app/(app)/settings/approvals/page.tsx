import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PageHeader } from '@/components/ui';
import { ApprovalWorkflowsClient } from './approvals-client';

export const dynamic = 'force-dynamic';

/**
 * Approval Workflows builder. Defining who must approve which documents at which amount
 * is a financial-CONTROL action, so it sits behind settings_system:edit. Fails closed.
 */
export default async function ApprovalWorkflowsPage() {
  await requirePagePermission('settings_system', 'edit');
  return (
    <>
      <PageHeader
        title="Approval Workflows"
        description="Configure N-step approval chains per document type and amount tier — who must approve a bill, journal entry, payment, expense, or payroll run, and in what order. Documents route automatically; a doc type with no active workflow keeps its existing single-approver behavior."
      />
      <ApprovalWorkflowsClient />
    </>
  );
}
