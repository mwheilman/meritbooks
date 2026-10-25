export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { ProposalUpdate, toColumns } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

const COLS = {
  customerId: 'customer_id', projectName: 'project_name', baseBidCents: 'base_bid_cents', alternates: 'alternates', unitPrices: 'unit_prices', inclusions: 'inclusions',
  exclusions: 'exclusions', qualifications: 'qualifications', scheduleAssumptions: 'schedule_assumptions', validUntil: 'valid_until',
} as const;

/** PATCH /api/commercial/proposals/:id — edit a draft (a sent proposal is locked: revise by a new one). */
export const PATCH = route({ access: { cap: 'projects.estimates', action: 'edit' }, mask: ['estimate', 'trade_proposal'], body: ProposalUpdate }, async ({ db, body, params }) => {
  const patch = toColumns(body, COLS);
  if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_proposals').update(patch).eq('id', params.proposalId!).select('id').single());
});
