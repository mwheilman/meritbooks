import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { write } from '@/lib/pm/ops/rpc';
import { Cents, Day, Need, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.object({
  jobId: Uuid,
  category: Need(80, 'Pick or type a category'),
  title: Need(200, 'Name the decision'),
  description: Text(2000).nullish(),
  allowanceCents: Cents.nullish(),
  dueOn: Day.nullish(),
});

/** A decision the client owes (OPEN). Options, proposal and approval follow on the selection. */
export const POST = route({ body: Body }, async ({ db, body, tenant }) => {
  const job = await loadJob(db, body.jobId);
  assertCompany(tenant, job.location_id);
  const pm = db.schema('pm');
  const last = await pm.from('selections').select('sort').eq('job_id', job.job_id).order('sort', { ascending: false }).limit(1);
  const sort = ((last.data as Array<{ sort: number }> | null)?.[0]?.sort ?? -1) + 1;
  const r = await write<Array<{ id: string }>>(
    pm.from('selections').insert({
      job_id: job.job_id, category: body.category, title: body.title, description: body.description || null,
      allowance_cents: body.allowanceCents ?? null, due_on: body.dueOn ?? null, sort,
    }).select('id'),
    'add selection',
  );
  if (!r[0]) throw new HttpError(500, 'The selection was not saved. Try again.', 'CREATE_FAILED');
  return { selectionId: r[0].id };
});
