export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { InspectionAction } from '@/lib/commercial/schemas';
import { cmError, cmRpc, cmWrote } from '@/lib/commercial/server';

/** GET /api/commercial/inspections/:id — the checklist items with their answers. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false }, async ({ db, params }) => {
  const res = await db.schema('pm').from('cm_inspection_items').select('id, sort, section, label, requires_photo, response, value, note, photo_ids, observation_id').eq('inspection_id', params.inspectionId!).order('sort');
  if (res.error) throw cmError(res.error);
  return { items: res.data ?? [] };
});

/** POST /api/commercial/inspections/:id — answer an item, or complete it (every item answered; each failure opens an observation). */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: InspectionAction }, async ({ db, body, params }) => {
  if (body.op === 'complete') return cmRpc<Record<string, unknown>>(db, 'cm_complete_inspection', { p_inspection: params.inspectionId!, p_signer_name: body.signerName, p_signature_png: body.signaturePng });
  return cmWrote<{ id: string }>(await db.schema('pm').from('cm_inspection_items').update({ response: body.response, note: body.note, value: body.value })
    .eq('id', body.itemId).eq('inspection_id', params.inspectionId!).select('id').single());
});
