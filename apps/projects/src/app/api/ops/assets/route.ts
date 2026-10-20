import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { write } from '@/lib/pm/ops/rpc';
import { Uuid } from '@/lib/pm/ops/schemas';
import { AssetFields, assetColumns } from '@/lib/pm/ops/asset-fields';

const Body = AssetFields.extend({ companyId: Uuid }).refine((b) => !!(b.serialNumber || b.make || b.model || b.description), {
  message: 'Give the serial, make and model, or a description', path: ['serialNumber'],
});

/** Add equipment (identity is unique by make + serial; the database refuses a duplicate). */
export const POST = route({ body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const r = await write<Array<{ id: string }>>(db.schema('pm').from('assets').insert({ location_id: body.companyId, ...assetColumns(body) }).select('id'), 'add equipment');
  if (!r[0]) throw new HttpError(500, 'The equipment was not saved. Try again.', 'CREATE_FAILED');
  return { assetId: r[0].id };
});
