export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { RfiAction } from '@/lib/commercial/schemas';
import { cmRpc, loadRfi } from '@/lib/commercial/server';

/** GET /api/commercial/rfis/:id — the RFI and its thread (the official answer marked). */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false }, async ({ db, params }) => {
  const r = await loadRfi(db, params.rfiId!);
  if (!r.rfi) throw new HttpError(404, 'That RFI was not found.', 'NOT_FOUND');
  return r;
});

/** POST /api/commercial/rfis/:id — open, move the ball, respond (official answers return it to the author), close / reopen, open a change event from its cost impact. */
export const POST = route({
  access: { cap: 'projects.jobs', action: 'edit' },
  ops: { to_change_event: { cap: 'projects.change_orders', action: 'create' } },
  mask: false,
  body: RfiAction,
}, async ({ db, body, params }) => {
  const id = params.rfiId!;
  switch (body.op) {
    case 'open':
      return { id: await cmRpc<string>(db, 'cm_rfi_open', { p_rfi: id, p_due: body.dueOn }) };
    case 'ball':
      return { id: await cmRpc<string>(db, 'cm_rfi_set_ball', { p_rfi: id, p_kind: body.kind, p_membership: body.membershipId, p_contact: null, p_name: body.name, p_email: body.email, p_due: body.dueOn }) };
    case 'respond':
      return { id: await cmRpc<string>(db, 'cm_rfi_respond', { p_rfi: id, p_body: body.body, p_official: body.official, p_author_name: body.authorName, p_via: 'APP' }) };
    case 'close':
      return { id: await cmRpc<string>(db, 'cm_rfi_close', { p_rfi: id, p_reopen: false }) };
    case 'reopen':
      return { id: await cmRpc<string>(db, 'cm_rfi_close', { p_rfi: id, p_reopen: true }) };
    case 'to_change_event':
      return { changeEventId: await cmRpc<string>(db, 'cm_rfi_to_change_event', { p_rfi: id }) };
  }
});
