import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { loadJob } from '@/lib/pm/guarded';
import { rows } from '@/lib/pm/db';
import { write } from '@/lib/pm/ops/rpc';
import { AREA_COLS, type MeasureAreaRow } from '@/lib/pm/ops/types';
import { Day, Text, Uuid } from '@/lib/pm/ops/schemas';

const Body = z.object({
  jobId: Uuid,
  measuredOn: Day.nullish(),
  notes: Text(2000).nullish(),
  /** Start the new version from an earlier takeoff's areas. */
  copyFromId: Uuid.nullish(),
});

/** A draft takeoff version (pm.tg_measure numbers it). */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, body: Body }, async ({ db, body, tenant }) => {
  const job = await loadJob(db, body.jobId);
  assertCompany(tenant, job.location_id);
  const pm = db.schema('pm');
  const r = await write<Array<{ id: string; version: number }>>(
    pm.from('measures').insert({ job_id: job.job_id, measured_on: body.measuredOn ?? undefined, notes: body.notes || null }).select('id, version'),
    'start measure',
  );
  const m = r[0];
  if (!m) throw new HttpError(500, 'The measure was not started. Try again.', 'CREATE_FAILED');
  if (body.copyFromId) {
    const src = rows<MeasureAreaRow>(await pm.from('measure_areas').select(AREA_COLS).eq('measure_id', body.copyFromId).eq('job_id', job.job_id).order('sort'), 'areas to copy');
    if (src.length) {
      await write(
        pm.from('measure_areas').insert(src.map((a) => ({
          measure_id: m.id, job_id: job.job_id, room_name: a.room_name, area_kind: a.area_kind, product_category: a.product_category, length_ft: a.length_ft,
          width_ft: a.width_ft, sqft: a.sqft, linear_ft: a.linear_ft, each_count: a.each_count, waste_pct: a.waste_pct, material_uom: a.material_uom,
          coverage_sf_per_unit: a.coverage_sf_per_unit, sort: a.sort, notes: a.notes,
        }))).select('id'),
        'copy areas',
      );
    }
  }
  return { measureId: m.id, version: m.version };
});
