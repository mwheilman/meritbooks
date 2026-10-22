import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { write } from '@/lib/pm/ops/rpc';
import { Cents, Day, Need, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.object({
  jobId: Uuid,
  unitNumber: Need(40, 'Number the lot or unit'),
  unitKind: z.enum(['LOT', 'SINGLE_FAMILY', 'TOWNHOME', 'CONDO', 'APARTMENT', 'COMMERCIAL', 'PAD']).default('LOT'),
  phase: Text(60).nullish(),
  planName: Text(80).nullish(),
  sqft: z.number().min(0).max(1e7).nullish(),
  status: z.enum(['PLANNED', 'ENTITLED', 'AVAILABLE', 'UNDER_CONSTRUCTION', 'COMPLETE', 'HELD']).default('PLANNED'),
  listPriceCents: Cents.nullish(),
  lenderReleasePriceCents: Cents.nullish(),
  estCloseOn: Day.nullish(),
  /** Add a numbered run at once: "1-24" with a prefix makes Lot 1 … Lot 24. */
  count: z.number().int().min(1).max(500).default(1),
});

/** Lots / units on a development job (pre-sale states only; sales move through pm.set_unit_status). */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: 'dev_unit', body: Body }, async ({ db, body, tenant }) => {
  const job = await loadJob(db, body.jobId);
  assertCompany(tenant, job.location_id);
  const base = body.unitNumber;
  const m = /^(.*?)(\d+)$/.exec(base);
  const numbers = body.count > 1
    ? Array.from({ length: body.count }, (_, i) => (m ? `${m[1]}${String(Number(m[2]) + i).padStart(m[2]!.length, '0')}` : `${base}-${i + 1}`))
    : [base];
  const r = await write<Array<{ id: string }>>(
    db.schema('pm').from('units').insert(numbers.map((n, i) => ({
      job_id: job.job_id, unit_number: n, unit_kind: body.unitKind, phase: body.phase || null, plan_name: body.planName || null, sqft: body.sqft ?? null,
      status: body.status, list_price_cents: body.listPriceCents ?? null, lender_release_price_cents: body.lenderReleasePriceCents ?? null,
      est_close_on: body.estCloseOn ?? null, sort: i,
    }))).select('id'),
    'add units',
  );
  if (!r.length) throw new HttpError(500, 'The units were not saved. Try again.', 'CREATE_FAILED');
  return { created: r.length };
});
