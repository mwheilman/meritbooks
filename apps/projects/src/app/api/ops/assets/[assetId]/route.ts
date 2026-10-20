export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { call, own, write } from '@/lib/pm/ops/rpc';
import { loadAssetHistory } from '@/lib/pm/ops/field-queries';
import { Day, Text, Uuid } from '@/lib/pm/ops/schemas';
import { AssetFields, assetColumns } from '@/lib/pm/ops/asset-fields';

const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('service'),
    kind: z.enum(['INSTALL', 'REPAIR', 'MAINTENANCE', 'INSPECTION', 'WARRANTY', 'RECALL', 'CALLBACK', 'PDI', 'METER_READING', 'NOTE']),
    summary: Text(2000).nullish(),
    performedOn: Day.nullish(),
    meter: z.number().min(0).max(1e9).nullish(),
  }),
  z.object({ op: z.literal('retire'), status: z.enum(['ACTIVE', 'REPLACED', 'RETIRED', 'SOLD']), replacedBy: Uuid.nullish(), on: Day.nullish() }),
  z.object({ op: z.literal('update'), fields: AssetFields.partial() }),
]);

export const GET = route({}, async ({ db, params }) => {
  await own(db, 'assets', 'id', { id: params.assetId! }, 'That equipment was not found.');
  return loadAssetHistory(db, params.assetId!);
});

export const POST = route({ body: Op }, async ({ db, params, body, tenant }) => {
  const a = await own<{ id: string; location_id: string }>(db, 'assets', 'id, location_id', { id: params.assetId! }, 'That equipment was not found.');
  assertCompany(tenant, a.location_id);
  switch (body.op) {
    case 'service': {
      const id = await call<string>(db, 'record_asset_service', {
        p_asset: a.id, p_kind: body.kind, p_summary: body.summary || null, p_performed_on: body.performedOn ?? null,
        p_work_order: null, p_meter: body.meter ?? null, p_employee: null, p_parts: [],
      });
      return { ok: true, historyId: id };
    }
    case 'retire':
      if (body.status === 'REPLACED' && !body.replacedBy) throw new HttpError(422, 'Pick the equipment that replaced it.', 'VALIDATION');
      await call(db, 'retire_asset', { p_asset: a.id, p_status: body.status, p_replaced_by: body.replacedBy ?? null, p_on: body.on ?? null });
      return { ok: true };
    case 'update': {
      const patch = assetColumns(body.fields);
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await write(db.schema('pm').from('assets').update(patch).eq('id', a.id).select('id'), 'update equipment');
      return { ok: true };
    }
  }
});
