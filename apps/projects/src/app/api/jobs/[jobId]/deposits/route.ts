export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { pm, rows } from '@/lib/pm/db';
import { DEPOSIT_COLS } from '@/lib/pm/money/queries';
import { assertMode, loadMoneyJob } from '@/lib/pm/money/job';
import { callRpc } from '@/lib/pm/money/rpc';
import { IsoDate, PosCents, Text200 } from '@/lib/pm/money/schemas';
import type { DepositRow } from '@/lib/pm/money/types';

const Body = z.object({
  amountCents: PosCents.refine((n) => n > 0, 'Enter a deposit above zero.'),
  memo: Text200.nullish(),
  occurredOn: IsoDate.nullish(),
});

export const GET = route({}, async ({ db, params }) => {
  const job = await loadMoneyJob(db, params.jobId!);
  return { deposits: rows<DepositRow>(await pm(db).from('deposit_requests').select(DEPOSIT_COLS).eq('job_id', job.job_id).order('created_at', { ascending: false }), 'deposits') };
});

/** pm.request_deposit: JOB_DEPOSIT_REQUEST to Merit Books (or UNISSUED with no Merit Books / a sample job). */
export const POST = route({ body: Body }, async ({ db, params, body }) => {
  const job = await loadMoneyJob(db, params.jobId!);
  assertMode(job, 'deposit');
  const id = await callRpc<string>(db, 'request_deposit', { p_job: job.job_id, p_amount_cents: body.amountCents, p_memo: body.memo ?? null, p_occurred_on: body.occurredOn ?? null }, 'deposit');
  const d = rows<{ status: string }>(await pm(db).from('deposit_requests').select('status').eq('id', id), 'deposit')[0];
  return { depositId: id, status: d?.status ?? 'EMITTED' };
});
