import { requirePagePermission } from '@/lib/rbac/page-guard';
import { ProjectsSeamView } from './projects-seam-view';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Merit Projects in Books' };

/**
 * /jobs/projects-seam — what Merit Projects sent to Books and what Books did with it (migration 194):
 * messages waiting or rejected (they block the hard close), commitments and the bills matched to them,
 * bills on a commitment payment hold, 3-way warnings, and job labor from payroll (hours awaiting payroll,
 * allocations, the optional standard-rate accrual). Books-only orgs see a short "not connected" note.
 */
export default async function ProjectsSeamPage() {
  await requirePagePermission('jobs', 'view');
  return <ProjectsSeamView />;
}
