export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { RfiCreate } from '@/lib/commercial/schemas';
import { cmRpc, cmWrote, loadRfis } from '@/lib/commercial/server';

/** GET /api/commercial/rfis?jobId= — the job's RFI log. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ jobId: Uuid }) }, async ({ db, query }) => {
  return { rfis: await loadRfis(db, [query.jobId]) };
});

/** POST /api/commercial/rfis — write an RFI and (by default) open it: numbered, due date from the contract response days, ball in court set (CGC-64). */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: RfiCreate }, async ({ db, body }) => {
  const r = cmWrote<{ id: string; number: string }>(await db.schema('pm').from('cm_rfis').insert({
    job_id: body.jobId, subject: body.subject, question: body.question, suggested_answer: body.suggestedAnswer, discipline: body.discipline,
    spec_section: body.specSection, drawing_ref: body.drawingRef, location_text: body.locationText, priority: body.priority, is_private: body.isPrivate,
    cost_impact: body.costImpact, schedule_impact: body.scheduleImpact, ball_in_court_kind: body.ballKind, ball_in_court_name: body.ballName,
    ball_in_court_email: body.ballEmail, due_on: body.dueOn,
  }).select('id, number').single());
  if (body.open) await cmRpc<string>(db, 'cm_rfi_open', { p_rfi: r.id, p_due: body.dueOn });
  return r;
});
