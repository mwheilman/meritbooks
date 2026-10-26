import { Suspense } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { Workspace } from './workspace';

export const metadata = { title: 'Client migration' };

/**
 * ONE CLIENT'S MIGRATION (spec §5.3, boards O-client-migration / O-connect-source /
 * O-preflight / O-mapping / O-tieout-certificate): the eight stages in plain words on the
 * left, the stage's work in the middle, the plan, people and trail on the right. merit-ui,
 * density cockpit. Page-level RBAC: journal_entries:view; the API refuses clients outside
 * the caller's scope (RLS + client scope).
 */
export default async function ClientMigrationPage({ params }: { params: { projectId: string } }) {
  await requirePagePermission('journal_entries', 'view');
  return (
    <Suspense fallback={<p className="t-cap">Loading the migration…</p>}>
      <Workspace projectId={params.projectId} />
    </Suspense>
  );
}
