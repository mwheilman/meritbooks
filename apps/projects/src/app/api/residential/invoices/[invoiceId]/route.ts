export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { resRpc } from '@/lib/residential/rpc';
import { Text } from '@/lib/residential/schemas';

const Op = z.discriminatedUnion('op', [
  // The person who entered the invoice cannot approve it. An overage becomes a commitment change
  // decided in Approvals (status 'VARIANCE' + approval 'pending' until the right approver acts);
  // then the compliance gate (HELD with reasons) — migration 1119, security review.
  z.object({ op: z.literal('approve'), reason: Text(1000).nullish() }),
  z.object({ op: z.literal('reject'), reason: Text(1000).min(3, 'Say why') }),
]);

export const POST = route({ access: { cap: 'projects.commitments', action: 'approve' }, mask: 'commitment', body: Op }, async ({ db, params, body }) =>
  body.op === 'approve'
    ? resRpc(db, 'res_approve_trade_invoice', { p_invoice: params.invoiceId!, p_reason: body.reason ?? null })
    : resRpc(db, 'res_reject_trade_invoice', { p_invoice: params.invoiceId!, p_reason: body.reason }));
