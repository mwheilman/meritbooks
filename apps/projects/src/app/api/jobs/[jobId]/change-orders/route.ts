export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { must, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { listChangeOrders } from '@/lib/pm/work';

const Cents = z.number().int().min(-1e13).max(1e13);
const Body = z.object({
  title: z.string().trim().min(1, 'Name the change').max(200),
  description: z.string().trim().max(2000).nullish(),
  reason: z.string().trim().max(200).nullish(),
  amountCents: Cents,
  costImpactCents: Cents.nullish(),
  scheduleDays: z.number().int().min(-3650).max(3650).nullish(),
  stage: z.enum(['PCO', 'COR']).default('PCO'),
});

export const GET = route({}, async ({ db, params }) => {
  const job = await loadJob(db, params.jobId!);
  return { changeOrders: await listChangeOrders(db, job.job_id) };
});

/** Create a potential (PCO) or requested (COR) change order. The number is minted by the database. */
export const POST = route({ body: Body }, async ({ db, params, body }) => {
  const job = await loadJob(db, params.jobId!);
  const co = must(
    await db.schema('pm').from('change_orders').insert({
      job_id: job.job_id, title: body.title, description: body.description ?? null, reason: body.reason ?? null,
      amount_cents: body.amountCents, cost_impact_cents: body.costImpactCents ?? null, schedule_days: body.scheduleDays ?? null,
      stage: body.stage,
    }).select('id, number').single(),
    'create change order',
  ) as { id: string; number: string };
  return { changeOrderId: co.id, number: co.number };
});
