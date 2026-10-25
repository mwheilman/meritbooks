export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { AssignmentUpdate, toColumns } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

const COLS = { status: 'status', days: 'days', perDiem: 'per_diem', travel: 'travel' } as const;

/** PATCH /api/commercial/workforce/:id — confirm, release, or change the days / per diem / travel of a booking. */
export const PATCH = route({ access: { cap: 'projects.dispatch', action: 'edit' }, mask: false, body: AssignmentUpdate }, async ({ db, body, params }) => {
  const patch = toColumns(body, COLS);
  if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_workforce_assignments').update(patch).eq('id', params.assignmentId!).select('id').single());
});

/** DELETE /api/commercial/workforce/:id — take a booking off the board. */
export const DELETE = route({ access: { cap: 'projects.dispatch', action: 'edit' }, mask: false }, async ({ db, params }) => {
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_workforce_assignments').delete().eq('id', params.assignmentId!).select('id').single());
});
