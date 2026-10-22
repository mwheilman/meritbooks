import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, must, route } from '@/lib/api';

const Body = z
  .object({ name: z.string().trim().min(1).max(80).optional(), isActive: z.boolean().optional() })
  .refine((b) => b.name !== undefined || b.isActive !== undefined, 'Nothing to change');

/** Rename or (de)activate a tenant cost code. Pack codes change only through the pack. */
export const PATCH = route({ access: { cap: 'projects.settings', action: 'configure' }, mask: false, body: Body }, async ({ db, params, body, tenant }) => {
  const cc = must(await db.schema('pm').from('cost_codes').select('id, location_id, install_id').eq('id', params.codeId!).maybeSingle(), 'cost code') as
    | { id: string; location_id: string; install_id: string | null } | null;
  if (!cc) throw new HttpError(404, 'That cost code was not found.', 'NOT_FOUND');
  assertCompany(tenant, cc.location_id);
  if (cc.install_id) throw new HttpError(422, 'This code comes from your industry setup. Change it with Change setup.', 'PACK_CODE');
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.isActive !== undefined) patch.is_active = body.isActive;
  must(await db.schema('pm').from('cost_codes').update(patch).eq('id', cc.id).select('id'), 'update cost code');
  return { ok: true };
});
