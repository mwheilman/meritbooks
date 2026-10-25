export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Text } from '@/lib/residential/schemas';

/** An invoice's approval chain (RED-23): steps, who acted, from which channel. */
export const GET = route({ access: { cap: 'projects.billing', action: 'view' }, mask: false }, async ({ db, params }) => {
  const steps = resWrote<Array<{ step_no: number; step_role: string; decision: string | null; decided_by: string | null; decided_at: string | null; note: string | null; channel: string }>>(
    await pm(db).from('dev_invoice_approvals').select('step_no, step_role, decision, decided_by, decided_at, note, channel').eq('invoice_id', params.invoiceId!).order('step_no'));
  return { steps };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('route') }),
  z.object({ op: z.literal('decide'), approve: z.boolean(), note: Text(1000).nullish(), channel: z.enum(['web', 'mobile', 'email']).default('web') }),
]);

/** route → the company's chain for the amount; decide → act at the current step (preparer ≠ approver, one step per person). */
export const POST = route({ access: { cap: 'projects.billing', action: 'view' }, mask: false, body: Body }, async ({ db, params, body }) => {
  if (body.op === 'route') return resRpc(db, 'dev_route_invoice', { p_invoice: params.invoiceId! });
  return resRpc(db, 'dev_decide_invoice_step', { p_invoice: params.invoiceId!, p_approve: body.approve, p_note: body.note ?? null, p_channel: body.channel });
});
