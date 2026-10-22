import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { write } from '@/lib/pm/ops/rpc';
import { Day, Need, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.object({
  jobId: Uuid,
  kind: z.enum(['PUNCH', 'WARRANTY', 'CALLBACK']).default('PUNCH'),
  title: Need(200, 'Say what needs fixing'),
  description: Text(4000).nullish(),
  area: Text(120).nullish(),
  dueOn: Day.nullish(),
  responsibleVendorId: Uuid.nullish(),
  billable: z.boolean().default(false),
});

export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, body: Body }, async ({ db, body, tenant }) => {
  const job = await loadJob(db, body.jobId);
  assertCompany(tenant, job.location_id);
  const r = await write<Array<{ id: string }>>(
    db.schema('pm').from('punch_items').insert({
      job_id: job.job_id, kind: body.kind, title: body.title, description: body.description || null, area: body.area || null,
      due_on: body.dueOn ?? null, responsible_vendor_id: body.responsibleVendorId ?? null, billable: body.billable,
    }).select('id'),
    'add punch item',
  );
  if (!r[0]) throw new HttpError(500, 'The item was not saved. Try again.', 'CREATE_FAILED');
  return { itemId: r[0].id };
});
