export const dynamic = 'force-dynamic';

import { assertCompany, route } from '@/lib/api';
import { xcall } from '@/lib/dealer/rpc';
import { CompanyQ } from '@/lib/dealer/schemas';

/** The install board: each crew's square feet booked per day against its capacity, with readiness per job. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, query: CompanyQ }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  return xcall(db, 'flr_install_board', { p_location: query.company, p_from: query.from ?? null, p_to: query.to ?? null });
});
