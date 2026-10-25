import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { loadCampaignReport } from '@/lib/fieldservice/queries';
import { Day, Uuid } from '@/lib/pm/ops/schemas';

const Query = z.object({ companyId: Uuid, from: Day, to: Day });

/** Campaign attribution (FS-106): calls → booked → completed revenue → job cost from Books. Money masked in the DB. */
export const GET = route({ access: { cap: 'projects.reports', action: 'view' }, mask: false, query: Query }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.companyId);
  return loadCampaignReport(db, query.companyId, query.from, query.to);
});
