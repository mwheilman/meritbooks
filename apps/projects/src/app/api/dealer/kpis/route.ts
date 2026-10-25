export const dynamic = 'force-dynamic';

import { assertCompany, route } from '@/lib/api';
import { xcall } from '@/lib/dealer/rpc';
import { CompanyQ } from '@/lib/dealer/schemas';

/** The dealer KPI board (parts fill, counter speed, lost sales, service productivity, warranty, units, rentals). */
export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: ['dealer_deal', 'dealer_unit', 'repair_order', 'parts_ticket'], query: CompanyQ }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  return xcall(db, 'dlr_kpis', { p_location: query.company, p_from: query.from ?? null, p_to: query.to ?? null });
});
