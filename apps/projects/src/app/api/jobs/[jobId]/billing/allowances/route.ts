export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { one, pm } from '@/lib/pm/db';
import { assertMode, loadMoneyJob } from '@/lib/pm/money/job';
import { callRpc } from '@/lib/pm/money/rpc';
import { IsoDate, PosCents, Uuid } from '@/lib/pm/money/schemas';

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('close'), allowanceId: Uuid, actualCents: PosCents }),
  z.object({ op: z.literal('bill_overage'), allowanceId: Uuid, occurredOn: IsoDate.nullish() }),
]);

/** close_allowance (variance becomes a potential change order) · bill_allowance_overage (after that CO is approved). */
export const POST = route({ body: Body }, async ({ db, params, body }) => {
  const job = await loadMoneyJob(db, params.jobId!);
  assertMode(job, 'allowance');
  const a = one<{ id: string; job_id: string }>(await pm(db).from('allowances').select('id, job_id').eq('id', body.allowanceId).maybeSingle(), 'allowance');
  if (!a || a.job_id !== job.job_id) throw new HttpError(404, 'That allowance is not on this job.', 'NOT_FOUND');
  if (body.op === 'close') {
    const coId = await callRpc<string | null>(db, 'close_allowance', { p_allowance: a.id, p_actual_cents: body.actualCents }, 'record');
    return { changeOrderId: coId };
  }
  const id = await callRpc<string>(db, 'bill_allowance_overage', { p_allowance: a.id, p_occurred_on: body.occurredOn ?? null }, 'billing request');
  return { requestId: id };
});
