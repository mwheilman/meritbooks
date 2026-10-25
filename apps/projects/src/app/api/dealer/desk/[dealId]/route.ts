export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { xcall } from '@/lib/dealer/rpc';
import { PosCents, Uuid } from '@/lib/dealer/schemas';

const Q = z.object({ down: z.coerce.number().int().min(0).max(1e12).default(0) });

/**
 * The deal desk: the worksheet (front / back gross, over-allowance, margin floor, the approval
 * state from the engine, delivery blockers incl. the floor-plan payoff), and the payment
 * scenarios side by side (cash, rebate vs promo rate, standard rate) for a down payment.
 */
export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: 'dealer_deal', query: Q }, async ({ db, params, query }) => {
  const [worksheet, payments] = await Promise.all([
    xcall<Record<string, unknown>>(db, 'dlr_deal_worksheet', { p_deal: params.dealId! }),
    xcall<Record<string, unknown>>(db, 'dlr_payment_scenarios', { p_deal: params.dealId!, p_down_cents: query.down }),
  ]);
  return { worksheet, payments };
});

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('apply_program'), programId: Uuid, downCents: PosCents.default(0) }),
  z.object({ op: z.literal('standard_fees') }),
]);

/** Put a finance program on the deal (rebate line or promo-rate terms) or add the store's standard fees. */
export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, mask: 'dealer_deal', body: Op }, async ({ db, params, body }) => {
  if (body.op === 'apply_program') return xcall(db, 'dlr_apply_program', { p_deal: params.dealId!, p_program: body.programId, p_down_cents: body.downCents });
  return { added: await xcall<number>(db, 'dlr_apply_standard_fees', { p_deal: params.dealId! }) };
});
