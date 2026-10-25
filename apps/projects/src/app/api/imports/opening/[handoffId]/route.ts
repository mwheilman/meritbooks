export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { loadHandoff, submitHandoff, tieOut } from '@/lib/imports/server';

const Body = z.object({ op: z.enum(['tieout', 'submit']) });

/** GET /api/imports/opening/:handoffId — the position, its Books-ready payload and its last tie-out. */
export const GET = route({ access: { cap: 'projects.settings', action: 'configure' } }, async ({ db, params, tenant }) => {
  const h = await loadHandoff(db, params.handoffId!);
  if (!h) throw new HttpError(404, 'That opening position was not found.', 'NOT_FOUND');
  assertCompany(tenant, h.location_id);
  return { handoff: h };
});

/** POST { op: 'tieout' } re-compares with Books now; { op: 'submit' } hands a VALIDATED position to Books. */
export const POST = route({ access: { cap: 'projects.settings', action: 'configure' }, body: Body }, async ({ db, params, body, tenant }) => {
  const h = await loadHandoff(db, params.handoffId!);
  if (!h) throw new HttpError(404, 'That opening position was not found.', 'NOT_FOUND');
  assertCompany(tenant, h.location_id);
  if (body.op === 'tieout') return { tieout: await tieOut(db, h.id) };
  return { submitted: await submitHandoff(db, h.id), tieout: await tieOut(db, h.id) };
});
