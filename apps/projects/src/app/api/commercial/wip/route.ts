export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { WipPin, WipQuery } from '@/lib/commercial/schemas';
import { cmRpc, loadWip } from '@/lib/commercial/server';

/** GET /api/commercial/wip?companyId=&periodEnd= — the CFMA WIP schedule: Books' posted run where there is one, else live (CGC-54). */
export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, mask: ['job', 'wip'], query: WipQuery }, async ({ db, query }) => {
  return { rows: await loadWip(db, query.companyId, query.periodEnd) };
});

/** POST /api/commercial/wip — pin the period: the rows are kept exactly as printed; pinning again makes a revision. */
export const POST = route({ access: { cap: 'projects.financials', action: 'edit' }, mask: false, body: WipPin }, async ({ db, body }) => {
  return { pinned: await cmRpc<number>(db, 'cm_pin_wip', { p_location: body.companyId, p_period_end: body.periodEnd }) };
});
