export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { SubPayAppCreate } from '@/lib/commercial/schemas';
import { cmRpc, loadSubPayApps } from '@/lib/commercial/server';

/** GET /api/commercial/sub-pay-apps?jobId= — subcontractor pay applications on a job (cost). */
export const GET = route({ access: { cap: 'projects.commitments', action: 'view' }, mask: ['commitment', 'sub_pay_app'], query: z.object({ jobId: Uuid }) }, async ({ db, query }) => {
  return { apps: await loadSubPayApps(db, [query.jobId]) };
});

/** POST /api/commercial/sub-pay-apps — enter a sub's pay application against its subcontract SOV (CGC-45). */
export const POST = route({ access: { cap: 'projects.commitments', action: 'edit' }, mask: ['commitment', 'sub_pay_app'], body: SubPayAppCreate }, async ({ db, body }) => {
  return { id: await cmRpc<string>(db, 'cm_create_sub_pay_app', { p_commitment: body.commitmentId, p_period_end: body.periodEnd, p_lines: body.lines }, 'commitment') };
});
