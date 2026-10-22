export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { getJobEstimates } from '@/lib/pm/money/queries';
import { assertModule, loadMoneyJob } from '@/lib/pm/money/job';
import { wrote } from '@/lib/pm/money/rpc';
import { IsoDate, Rate, Text200, Text2000 } from '@/lib/pm/money/schemas';

const Body = z.object({
  title: Text200.min(1).default('Estimate'),
  retainagePct: Rate.nullish(),
  validUntil: IsoDate.nullish(),
  notes: Text2000.nullish(),
});

/** Every estimate version on the job, with lines. */
export const GET = route({ access: { cap: 'projects.estimates', action: 'view' }, mask: 'estimate' }, async ({ db, params }) => {
  const job = await loadMoneyJob(db, params.jobId!);
  return getJobEstimates(db, job.job_id);
});

/** A new DRAFT estimate (number minted EST-{short}-{YYYY}-{NNNN} by the trigger; customer = the job's). */
export const POST = route({ access: { cap: 'projects.estimates', action: 'create' }, mask: 'estimate', body: Body }, async ({ db, params, body }) => {
  const job = await loadMoneyJob(db, params.jobId!);
  assertModule(job, 'estimates', 'estimates');
  const e = wrote<{ id: string; number: string }>(
    await db.schema('pm').from('estimates')
      .insert({ job_id: job.job_id, title: body.title, retainage_pct: body.retainagePct ?? null, valid_until: body.validUntil ?? null, notes: body.notes ?? null })
      .select('id, number').single(),
    'estimate',
  );
  return { estimateId: e.id, number: e.number };
});
