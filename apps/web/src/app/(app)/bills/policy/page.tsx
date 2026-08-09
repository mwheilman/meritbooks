import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PageHeader } from '@/components/ui';
import { ApPolicyClient } from './ap-policy-client';
import { BillsTabs } from '../bills-tabs';

export const dynamic = 'force-dynamic';

export default async function ApPolicyPage() {
  // PAGE-LEVEL RBAC: compiling/activating a bill-approval policy is a financial control
  // action (it governs which bills may be posted, how they route for approval, and what
  // BLOCKS), so it sits behind the bills-approve grant. Fails closed.
  await requirePagePermission('bills', 'approve');
  return (
    <>
      <PageHeader
        title="AP Approval Policy"
        description="Drop your written bill-approval policy — AI compiles it into a structured, versioned ruleset you review and activate. A deterministic engine then enforces it on every bill: approval routing by amount, per-vendor / per-GL limits, require-PO and 3-way-match gates, prohibited vendors, and duplicate-bill blocking."
      />
      <div className="mb-6">
        <BillsTabs />
      </div>
      <ApPolicyClient />
    </>
  );
}
