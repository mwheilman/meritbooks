import { PageHeader } from '@/components/ui';
import { CloseGrid } from './close-grid';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const dynamic = 'force-dynamic';

export default async function ClosePage() {
  // PAGE-LEVEL RBAC (identity gate #9). Only roles that may view close
  // management reach this screen; everyone else is redirected. Fails closed.
  await requirePagePermission('close_mgmt', 'view');
  return (
    <>
      <PageHeader
        title="Close Management"
        description="Month-end close across all entities — 3 phases per company"
      />
      <CloseGrid />
    </>
  );
}
