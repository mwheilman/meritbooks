export const dynamic = 'force-dynamic';

import { CostApprovalsClient } from './cost-approvals-client';

export default function CostApprovalsPage() {
  return (
    <div className="px-6 py-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-white tracking-tight">Cost Approvals & Billing Seam</h1>
        <p className="text-sm text-slate-400 mt-1">
          Books is the sole cost processor. Approve job costs (or route them to a responsible party), then Books emits the cleared cost to Projects. Incoming billing requests from Projects are issued as invoices here.
        </p>
      </div>
      <CostApprovalsClient />
    </div>
  );
}
