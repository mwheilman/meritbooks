import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { write } from '@/lib/pm/ops/rpc';
import { Day, Need, Text, Uuid } from '@/lib/pm/ops/schemas';

export const POST = route(
  {
    body: z.object({
      jobId: Uuid,
      unitId: Uuid.nullish(),
      kind: z.enum(['LAND_ACQUISITION', 'ZONING', 'SITE_PLAN', 'PRELIMINARY_PLAT', 'FINAL_PLAT', 'ENVIRONMENTAL', 'UTILITY', 'GRADING_PERMIT', 'BUILDING_PERMIT', 'CERTIFICATE_OF_OCCUPANCY', 'OTHER']),
      name: Need(160, 'Name the approval'),
      authority: Text(160).nullish(),
      referenceNumber: Text(80).nullish(),
      status: z.enum(['NOT_STARTED', 'IN_PREP']).default('NOT_STARTED'),
      targetOn: Day.nullish(),
    }),
  },
  async ({ db, body, tenant }) => {
    const job = await loadJob(db, body.jobId);
    assertCompany(tenant, job.location_id);
    const r = await write<Array<{ id: string }>>(
      db.schema('pm').from('entitlements').insert({
        job_id: job.job_id, unit_id: body.unitId ?? null, kind: body.kind, name: body.name, authority: body.authority || null,
        reference_number: body.referenceNumber || null, status: body.status, target_on: body.targetOn ?? null,
      }).select('id'),
      'add entitlement',
    );
    if (!r[0]) throw new HttpError(500, 'The approval was not saved. Try again.', 'CREATE_FAILED');
    return { entitlementId: r[0].id };
  },
);
