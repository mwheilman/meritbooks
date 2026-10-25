export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { BuyoutUpdate, toColumns } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

const COLS = { status: 'status', needBy: 'need_by', leadTimeDays: 'lead_time_days', budgetOverrideCents: 'budget_override_cents', commitmentIds: 'commitment_ids', notes: 'notes' } as const;

/** PATCH /api/commercial/buyout/:id — move a package along (bidding, bought, not needed), its need-by date and the subcontracts that buy it. */
export const PATCH = route({ access: { cap: 'projects.commitments', action: 'edit' }, mask: ['budget', 'commitment'], body: BuyoutUpdate }, async ({ db, body, params }) => {
  const patch = toColumns(body, COLS);
  if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_buyout_packages').update(patch).eq('id', params.packageId!).select('id').single());
});
