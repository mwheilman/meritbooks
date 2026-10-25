export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { ChangeEventCreate } from '@/lib/commercial/schemas';
import { cmWrote, loadChangeBoard } from '@/lib/commercial/server';
import { moneyVisFor } from '@/components/money/visibility';

/** GET /api/commercial/change-events?jobId= — the job's change events, PCOs, RFQs and exposure (CGC-32..37). */
export const GET = route({ access: { cap: 'projects.change_orders', action: 'view' }, mask: ['change_order', 'change_event'], query: z.object({ jobId: Uuid }) }, async ({ db, query, access, tenant }) => {
  const vis = moneyVisFor(access, tenant.activeCompanyId);
  return loadChangeBoard(db, [query.jobId], { contract: vis.contract, cost: vis.cost });
});

/**
 * POST /api/commercial/change-events — log a change event. Field roles log it without a price;
 * a ROM figure needs the money capability (the 1120 trigger refuses it otherwise).
 */
export const POST = route({ access: { cap: 'projects.change_orders', action: 'create' }, mask: ['change_order', 'change_event'], body: ChangeEventCreate }, async ({ db, body }) => {
  const row = {
    job_id: body.jobId, title: body.title, description: body.description, source_type: body.sourceType, scope: body.scope, reason_code: body.reasonCode,
    due_on: body.dueOn, schedule_days: body.scheduleDays,
    ...(body.romRevenueCents !== null ? { rom_revenue_cents: body.romRevenueCents } : {}),
    ...(body.romCostCents !== null ? { rom_cost_cents: body.romCostCents } : {}),
  };
  return cmWrote<{ id: string; number: string }>(await db.schema('pm').from('cm_change_events').insert(row).select('id, number').single());
});
