import { PageHeader } from '@/components/ui';
import { CloseOrchestration } from './close-grid';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const dynamic = 'force-dynamic';

export default async function ClosePage() {
  // PAGE-LEVEL RBAC (identity gate #9). Only roles that may view close
  // management reach this screen; everyone else is redirected. Fails closed.
  await requirePagePermission('close_mgmt', 'view');
  return (
    <>
      <PageHeader
        title="Close Command Center"
        description="Ordered close task graph per entity — auto-verified from live data, with a blocking hard-close gate"
      />
      <CloseOrchestration />
    </>
  );
}
