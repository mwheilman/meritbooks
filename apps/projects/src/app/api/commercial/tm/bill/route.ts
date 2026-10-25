export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { TmBill } from '@/lib/commercial/schemas';
import { cmRpc } from '@/lib/commercial/server';

/** POST /api/commercial/tm/bill — bill signed T&M tickets at the rate sheet (each ticket bills once, CGC-52). */
export const POST = route({ access: { cap: 'projects.billing', action: 'create' }, mask: ['billing'], body: TmBill }, async ({ db, body }) => {
  return { requestId: await cmRpc<string>(db, 'cm_bill_tm_tickets', { p_job: body.jobId, p_tickets: body.ticketIds, p_occurred_on: body.occurredOn }, 'billing request') };
});
