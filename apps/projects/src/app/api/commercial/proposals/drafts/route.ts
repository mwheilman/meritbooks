export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { ProposalCreate } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

/** POST /api/commercial/proposals/drafts — start a trade proposal to a GC (CGC-25), numbered PR-<company>-<year>-NNN. */
export const POST = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: ['estimate', 'trade_proposal'], body: ProposalCreate }, async ({ db, body }) => {
  return cmWrote<{ id: string; number: string }>(await db.schema('pm').from('cm_proposals').insert({
    location_id: body.companyId, customer_id: body.customerId, project_name: body.projectName, base_bid_cents: body.baseBidCents, alternates: body.alternates,
    unit_prices: body.unitPrices, inclusions: body.inclusions, exclusions: body.exclusions, qualifications: body.qualifications,
    schedule_assumptions: body.scheduleAssumptions, valid_until: body.validUntil,
  }).select('id, number').single());
});
