import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { route } from '@/lib/api';
import { call, own, write } from '@/lib/pm/ops/rpc';
import { Day, Text } from '@/lib/pm/ops/schemas';

const Op = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('status'),
    status: z.enum(['NOT_STARTED', 'IN_PREP', 'SUBMITTED', 'UNDER_REVIEW', 'HEARING_SCHEDULED', 'APPROVED', 'APPROVED_WITH_CONDITIONS', 'DENIED', 'EXPIRED', 'WITHDRAWN']),
    on: Day.nullish(),
    reference: Text(80).nullish(),
    conditions: Text(4000).nullish(),
    expiresOn: Day.nullish(),
  }),
  z.object({ op: z.literal('update'), targetOn: Day.nullish(), authority: Text(160).nullish(), expiresOn: Day.nullish() }),
  z.object({ op: z.literal('delete') }),
]);

export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, body: Op }, async ({ db, params, body }) => {
  const e = await own<{ id: string; status: string }>(db, 'entitlements', 'id, status', { id: params.entitlementId! }, 'That approval was not found.');
  switch (body.op) {
    case 'status':
      await call(db, 'record_entitlement_status', { p_entitlement: e.id, p_status: body.status, p_on: body.on ?? null, p_reference: body.reference || null, p_conditions: body.conditions || null, p_expires_on: body.expiresOn ?? null });
      return { ok: true };
    case 'update': {
      const patch: Record<string, unknown> = {};
      if (body.targetOn !== undefined) patch.target_on = body.targetOn;
      if (body.authority !== undefined) patch.authority = body.authority || null;
      if (body.expiresOn !== undefined) patch.expires_on = body.expiresOn;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
      await write(db.schema('pm').from('entitlements').update(patch).eq('id', e.id).select('id'), 'update approval');
      return { ok: true };
    }
    case 'delete':
      if (!['NOT_STARTED', 'IN_PREP', 'WITHDRAWN'].includes(e.status)) throw new HttpError(422, 'Only an approval not yet submitted (or withdrawn) can be deleted.', 'VALIDATION');
      await write(db.schema('pm').from('entitlements').delete().eq('id', e.id).select('id'), 'delete approval');
      return { ok: true };
  }
});
