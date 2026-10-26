import { Suspense } from 'react';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { TowerScreen } from './tower-screen';

export const metadata = { title: 'Migration Control Tower' };

/**
 * MIGRATION CONTROL TOWER (08-ONBOARDING-V2-SPEC §6, board O-control-tower) — every client
 * being moved onto MeritBooks, by wave (a wave is a cutover date), with the eight stages in
 * plain words, blockers in dollars and the one next step. Built on merit-ui (density
 * cockpit). Page-level RBAC: journal_entries:view (rows are client-scoped by RLS).
 */
export default async function MigrationTowerPage() {
  await requirePagePermission('journal_entries', 'view');
  return (
    <Suspense fallback={<p className="t-cap">Loading the Tower…</p>}>
      <TowerScreen />
    </Suspense>
  );
}
