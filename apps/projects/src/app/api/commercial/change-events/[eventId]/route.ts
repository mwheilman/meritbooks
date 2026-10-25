export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { ChangeEventAction } from '@/lib/commercial/schemas';
import { cmRpc, cmWrote, cmError, loadRfqs } from '@/lib/commercial/server';
import type { ChangeEventRow } from '@/lib/commercial/types';

/** GET /api/commercial/change-events/:id — the event, its lines and its RFQs. */
export const GET = route({ access: { cap: 'projects.change_orders', action: 'view' }, mask: ['change_order', 'change_event', 'commitment'] }, async ({ db, params }) => {
  const pm = db.schema('pm');
  const [ev, lines] = await Promise.all([
    pm.from('v_cm_change_events_masked').select('*').eq('id', params.eventId!).maybeSingle(),
    pm.from('v_cm_change_event_lines_masked').select('*').eq('change_event_id', params.eventId!).order('line_no'),
  ]);
  if (ev.error) throw cmError(ev.error);
  if (!ev.data) throw new HttpError(404, 'That change was not found.', 'NOT_FOUND');
  const event = ev.data as ChangeEventRow;
  const rfqs = await loadRfqs(db, event.id).catch(() => []);
  return { event, lines: lines.data ?? [], rfqs };
});

/** POST /api/commercial/change-events/:id — status, proceeding (CCD), RFQ to a sub, ROM price. */
export const POST = route({
  access: { cap: 'projects.change_orders', action: 'edit' },
  ops: { rfq: { cap: 'projects.financials', action: 'view' } },
  mask: ['change_order', 'change_event'],
  body: ChangeEventAction,
}, async ({ db, body, params }) => {
  const id = params.eventId!;
  switch (body.op) {
    case 'status':
      return { id: await cmRpc<string>(db, 'cm_change_event_set_status', { p_change_event: id, p_status: body.status, p_note: body.note }) };
    case 'proceed':
      return { id: await cmRpc<string>(db, 'cm_change_event_proceed', { p_change_event: id, p_proceeding: body.proceeding, p_directive: body.directive, p_since: body.since }) };
    case 'rfq':
      return { rfqId: await cmRpc<string>(db, 'cm_send_rfq', { p_change_event: id, p_vendor: body.vendorId, p_commitment: body.commitmentId, p_due: body.dueOn, p_scope: body.scope }) };
    case 'price': {
      const patch: Record<string, number | null> = {};
      if (body.romRevenueCents !== null) patch.rom_revenue_cents = body.romRevenueCents;
      if (body.romCostCents !== null) patch.rom_cost_cents = body.romCostCents;
      if (!Object.keys(patch).length) throw new HttpError(422, 'Enter a sell or a cost figure.', 'VALIDATION');
      return cmWrote<{ id: string }>(await db.schema('pm').from('cm_change_events').update(patch).eq('id', id).select('id').single());
    }
  }
});
