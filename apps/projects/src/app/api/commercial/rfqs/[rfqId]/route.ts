export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { RfqAction } from '@/lib/commercial/schemas';
import { cmRpc } from '@/lib/commercial/server';

/** POST /api/commercial/rfqs/:id — record the sub's priced response (by line), or accept / decline it. */
export const POST = route({ access: { cap: 'projects.change_orders', action: 'edit' }, ops: { respond: { cap: 'projects.financials', action: 'view' } }, mask: ['commitment'], body: RfqAction }, async ({ db, body, params }) => {
  if (body.op === 'decide') return { id: await cmRpc<string>(db, 'cm_rfq_decide', { p_rfq: params.rfqId!, p_accept: body.accept }) };
  const response: Record<string, string | number> = {};
  const put = (k: string, v: string | number | null) => { if (v !== null) response[k] = v; };
  put('labor_cents', body.laborCents); put('material_cents', body.materialCents); put('equipment_cents', body.equipmentCents);
  put('subcontract_cents', body.subcontractCents); put('other_cents', body.otherCents); put('markup_cents', body.markupCents);
  put('total_cents', body.totalCents); put('schedule_days', body.scheduleDays); put('exclusions', body.exclusions); put('responder_name', body.responderName);
  return { id: await cmRpc<string>(db, 'cm_rfq_respond', { p_rfq: params.rfqId!, p_response: response }) };
});
