export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { CloseoutItemUpdate, toColumns } from '@/lib/commercial/screen-schemas';
import { cmWrote } from '@/lib/commercial/server';

const COLS = { status: 'status', dueOn: 'due_on', warrantyStartsOn: 'warranty_starts_on', warrantyYears: 'warranty_years', notes: 'notes', required: 'required' } as const;

/** PATCH /api/commercial/closeout/items/:id — status, due date, warranty start and term (the end date follows), notes. */
export const PATCH = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: CloseoutItemUpdate }, async ({ db, body, params }) => {
  const patch = toColumns(body, COLS);
  if (!Object.keys(patch).length) throw new HttpError(422, 'Nothing to change.', 'VALIDATION');
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_closeout_items').update(patch).eq('id', params.itemId!).select('id').single());
});
