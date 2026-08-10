import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PageHeader } from '@/components/ui';
import { PbcClient } from './pbc-client';

export const dynamic = 'force-dynamic';

/**
 * PBC ("Prepared by Client") request list — the shared workspace between an external
 * auditor and the client's accounting staff.
 *
 * PAGE GUARD: compliance.view (identity gate #9). The read-only External Auditor custom
 * role grants exactly this, so an auditor can reach the page to raise + accept requests;
 * the fulfill/assign/delete actions are separately gated on compliance.manage (which the
 * auditor role does NOT grant) at the API layer. Fails closed.
 */
export default async function PbcPage() {
  await requirePagePermission('compliance', 'view');
  return (
    <>
      <PageHeader
        title="Audit Requests (PBC)"
        description="The prepared-by-client list: auditors request supporting items, the client assigns and fulfills them by attaching a document, and the auditor accepts. Everything is tracked to close."
      />
      <PbcClient />
    </>
  );
}
