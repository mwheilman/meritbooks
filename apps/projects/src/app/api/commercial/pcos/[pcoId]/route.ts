export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { HttpError } from '@/lib/api-errors';
import { PcoAction } from '@/lib/commercial/schemas';
import { cmError, cmRpc } from '@/lib/commercial/server';

/** GET /api/commercial/pcos/:id — the PCO with its priced lines (cost masked by the view). */
export const GET = route({ access: { cap: 'projects.change_orders', action: 'view' }, mask: ['change_order', 'change_event', 'estimate'] }, async ({ db, params }) => {
  const pm = db.schema('pm');
  const [p, l] = await Promise.all([
    pm.from('v_cm_pcos_masked').select('*').eq('id', params.pcoId!).maybeSingle(),
    pm.from('v_cm_pco_lines_masked').select('*').eq('pco_id', params.pcoId!).order('line_no'),
  ]);
  if (p.error) throw cmError(p.error);
  if (!p.data) throw new HttpError(404, 'That PCO was not found.', 'NOT_FOUND');
  return { pco: p.data, lines: l.data ?? [] };
});

/** POST /api/commercial/pcos/:id — submit to the owner (becomes the prime CO), revise, reprice, draft the subs' COs. */
export const POST = route({
  access: { cap: 'projects.change_orders', action: 'edit' },
  ops: { propose_ccos: { cap: 'projects.commitments', action: 'create' }, submit: { cap: 'projects.contract_value', action: 'view' } },
  mask: ['change_order', 'change_event'],
  body: PcoAction,
}, async ({ db, body, params }) => {
  const id = params.pcoId!;
  switch (body.op) {
    case 'submit':
      return { changeOrderId: await cmRpc<string>(db, 'cm_submit_pco', { p_pco: id, p_due: body.dueOn }) };
    case 'revise':
      return { id: await cmRpc<string>(db, 'cm_revise_pco', { p_pco: id, p_note: body.note }) };
    case 'reprice':
      return { id: await cmRpc<string>(db, 'cm_reprice_pco', { p_pco: id }) };
    case 'propose_ccos': {
      const p = await db.schema('pm').from('cm_pcos').select('change_order_id').eq('id', id).maybeSingle();
      if (p.error) throw cmError(p.error);
      const co = (p.data as { change_order_id: string | null } | null)?.change_order_id;
      if (!co) throw new HttpError(409, 'Submit the PCO to the owner first; subcontract changes follow the owner change order.', 'PM_PCO_NOT_SUBMITTED');
      return { drafted: await cmRpc<number>(db, 'cm_propose_ccos', { p_change_order: co }) };
    }
  }
});
