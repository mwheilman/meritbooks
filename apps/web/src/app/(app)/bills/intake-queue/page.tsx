import { requirePagePermission } from '@/lib/rbac/page-guard';
import { IntakeQueueClient } from './intake-queue-client';
import { DocumentProposalsBanner } from '@/components/documents/document-proposals-banner';

export const metadata = { title: 'AP intake queue' };

export const dynamic = 'force-dynamic';

/**
 * AP document-reading intake queue.
 *
 * PAGE-LEVEL RBAC (identity gate #9): only roles that may view Bills/AP reach this
 * screen. Route handlers enforce create/dispose independently. Fails closed.
 */
export default async function IntakeQueuePage() {
  await requirePagePermission('bills', 'view');
  return (
    <>
      {/* Bills found in Documents that still need a company before they can be drafted here. */}
      <DocumentProposalsBanner kind="bill" />
      <IntakeQueueClient />
    </>
  );
}
