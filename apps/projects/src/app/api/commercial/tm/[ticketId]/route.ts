export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { TmAction } from '@/lib/commercial/schemas';
import { cmRpc } from '@/lib/commercial/server';

/** GET /api/commercial/tm/:id — the ticket priced at the contract rate sheet (sell; needs contract value). */
export const GET = route({ access: { cap: 'projects.contract_value', action: 'view' }, mask: ['billing', 'time_entry'] }, async ({ db, params }) => {
  return cmRpc<Record<string, unknown>>(db, 'cm_tm_price', { p_ticket: params.ticketId! });
});

/** POST /api/commercial/tm/:id — submit for the GC's signature, sign (on the device), dispute, pull crew hours, open a change event. */
export const POST = route({
  access: { cap: 'projects.time', action: 'create' },
  ops: { dispute: { cap: 'projects.time', action: 'edit' }, to_change_event: { cap: 'projects.change_orders', action: 'create' } },
  mask: false,
  body: TmAction,
}, async ({ db, body, params }) => {
  const id = params.ticketId!;
  switch (body.op) {
    case 'submit':
      return { id: await cmRpc<string>(db, 'cm_tm_submit', { p_ticket: id }) };
    case 'sign':
      return { id: await cmRpc<string>(db, 'cm_tm_sign', { p_ticket: id, p_signer_name: body.signerName, p_signer_title: body.signerTitle, p_signer_company: body.signerCompany, p_signature_png: body.signaturePng, p_method: body.method }) };
    case 'dispute':
      return { id: await cmRpc<string>(db, 'cm_tm_dispute', { p_ticket: id, p_reason: body.reason }) };
    case 'pull_hours':
      return { added: await cmRpc<number>(db, 'cm_tm_pull_hours', { p_ticket: id, p_employees: null }) };
    case 'to_change_event':
      return { changeEventId: await cmRpc<string>(db, 'cm_tm_to_change_event', { p_ticket: id }) };
  }
});
