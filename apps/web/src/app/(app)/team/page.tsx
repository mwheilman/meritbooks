import { requirePagePermission } from '@/lib/rbac/page-guard';
import { TeamClient } from './team-client';

export const dynamic = 'force-dynamic';

export default async function TeamPage() {
  // PAGE-LEVEL RBAC (identity gate #9). Only roles that may view Team reach this
  // screen; everyone else is redirected. Fails closed. Within the screen, the
  // manage-vs-read-only split (canManageUsers) and the /api/team routes continue
  // to gate mutations independently.
  await requirePagePermission('team', 'view');
  return <TeamClient />;
}
