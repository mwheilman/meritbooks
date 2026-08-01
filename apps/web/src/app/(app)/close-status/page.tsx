import { PageHeader } from '@/components/ui';
import { CloseStatusBoard } from './close-status-board';
import { requirePagePermission } from '@/lib/rbac/page-guard';

export const dynamic = 'force-dynamic';

/**
 * Close Command Center — the accounting-manager / practice-supervisor surface.
 * Real-time, read-only "where is every entity in the close, and what's blocking
 * a clean one." PAGE-LEVEL RBAC (identity gate #9): only roles that may view
 * close management reach this screen; everyone else is redirected. Fails closed.
 */
export default async function CloseStatusPage() {
  await requirePagePermission('close_mgmt', 'view');
  return (
    <>
      <PageHeader
        title="Close Command Center"
        description="Real-time close readiness across every entity — derived from the live books, not a checklist."
      />
      <CloseStatusBoard />
    </>
  );
}
