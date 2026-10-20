import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { rows } from '@/lib/pm/db';
import { call, own, write } from '@/lib/pm/ops/rpc';
import { Need, Text, Uuid } from '@/lib/pm/ops/schemas';

const Dim = z.number().positive().max(1e6).nullish();
const AreaFields = z
  .object({
    roomName: Need(120, 'Name the room or area'),
    areaKind: z.enum(['FLOOR', 'STAIRS', 'WALL', 'BASE', 'TRANSITION', 'OTHER']).default('FLOOR'),
    productCategory: z.enum(['CARPET', 'LVP', 'HARDWOOD', 'LAMINATE', 'TILE', 'VINYL_SHEET', 'RUBBER', 'OTHER']).nullish(),
    lengthFt: Dim,
    widthFt: Dim,
    sqft: z.number().min(0).max(1e8).nullish(),
    linearFt: z.number().min(0).max(1e8).nullish(),
    eachCount: z.number().min(0).max(1e6).nullish(),
    wastePct: z.number().min(0).max(1).default(0.1),
    materialUom: z.enum(['SF', 'SY', 'LF', 'EA', 'BOX']).default('SF'),
    coverageSfPerUnit: z.number().positive().max(1e5).nullish(),
    notes: Text(1000).nullish(),
  })
  .refine((a) => a.materialUom !== 'BOX' || !!a.coverageSfPerUnit, { message: 'Boxes need the square feet one box covers', path: ['coverageSfPerUnit'] });

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_area'), area: AreaFields }),
  z.object({ op: z.literal('remove_area'), areaId: Uuid }),
  z.object({ op: z.literal('finalize') }),
  z.object({ op: z.literal('delete') }),
]);

export const POST = route({ body: Op }, async ({ db, params, body }) => {
  const m = await own<{ id: string; job_id: string; status: string }>(db, 'measures', 'id, job_id, status', { id: params.measureId! }, 'That measure was not found.');
  const pm = db.schema('pm');
  switch (body.op) {
    case 'add_area': {
      const a = body.area;
      const last = rows<{ sort: number }>(await pm.from('measure_areas').select('sort').eq('measure_id', m.id).order('sort', { ascending: false }).limit(1), 'last area');
      await write(
        pm.from('measure_areas').insert({
          measure_id: m.id, job_id: m.job_id, room_name: a.roomName, area_kind: a.areaKind, product_category: a.productCategory ?? null,
          length_ft: a.lengthFt ?? null, width_ft: a.widthFt ?? null, sqft: a.sqft ?? null, linear_ft: a.linearFt ?? null, each_count: a.eachCount ?? null,
          waste_pct: a.wastePct, material_uom: a.materialUom, coverage_sf_per_unit: a.coverageSfPerUnit ?? null, sort: (last[0]?.sort ?? -1) + 1, notes: a.notes || null,
        }).select('id'),
        'add area',
      );
      return { ok: true };
    }
    case 'remove_area':
      await write(pm.from('measure_areas').delete().eq('id', body.areaId).eq('measure_id', m.id).select('id'), 'remove area');
      return { ok: true };
    case 'finalize':
      await call(db, 'finalize_measure', { p_measure: m.id });
      return { ok: true };
    case 'delete':
      if (m.status !== 'DRAFT') throw new HttpError(422, 'Only a draft measure can be deleted.', 'VALIDATION');
      await write(pm.from('measures').delete().eq('id', m.id).select('id'), 'delete measure');
      return { ok: true };
  }
});
