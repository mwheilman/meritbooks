export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { CloseoutAction } from '@/lib/commercial/schemas';
import { cmError, cmRpc, cmWrote, loadCloseGate } from '@/lib/commercial/server';

/** GET /api/commercial/closeout?jobId= — the close gate (what still blocks closing the job) and the closeout package. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ jobId: Uuid }) }, async ({ db, query }) => {
  const [gate, items] = await Promise.all([
    loadCloseGate(db, query.jobId),
    db.schema('pm').from('cm_closeout_items').select('id, category, title, form_ref, vendor_id, spec_section, required, status, due_on, warranty_ends_on').eq('job_id', query.jobId).order('category').order('title'),
  ]);
  if (items.error) throw cmError(items.error);
  return { gate, items: items.data ?? [] };
});

/** POST /api/commercial/closeout — generate the closeout package from the job (O&Ms, warranties, as-builts, final waivers), set an item, close the job (refused while anything blocks). */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, ops: { close: { cap: 'projects.settings', action: 'configure' } }, mask: false, body: CloseoutAction }, async ({ db, body }) => {
  switch (body.op) {
    case 'generate':
      return { generated: await cmRpc<number>(db, 'cm_generate_closeout', { p_job: body.jobId }) };
    case 'close':
      return cmRpc<Record<string, unknown>>(db, 'cm_close_job', { p_job: body.jobId, p_note: body.note });
    case 'item':
      return cmWrote<{ id: string }>(await db.schema('pm').from('cm_closeout_items').update({ status: body.status }).eq('id', body.itemId).select('id').single());
  }
});
