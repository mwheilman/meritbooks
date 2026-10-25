export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { InspectionStart } from '@/lib/commercial/schemas';
import { cmError, cmRpc } from '@/lib/commercial/server';

/** GET /api/commercial/inspections?jobId= — the job's inspections and the company's checklist templates. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ jobId: Uuid }) }, async ({ db, query }) => {
  const pm = db.schema('pm');
  const [ins, tpl] = await Promise.all([
    pm.from('cm_inspections').select('id, job_id, template_id, number, title, category, area, inspected_on, inspector_name, status, result, signed_by_name, signed_at').eq('job_id', query.jobId).neq('status', 'VOID').order('created_at', { ascending: false }).limit(300),
    pm.from('cm_checklist_templates').select('id, name, category').order('name').limit(200),
  ]);
  if (ins.error) throw cmError(ins.error);
  return { inspections: ins.data ?? [], templates: tpl.data ?? [] };
});

/** POST /api/commercial/inspections — start an inspection from a checklist template. */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: InspectionStart }, async ({ db, body }) => {
  return { id: await cmRpc<string>(db, 'cm_start_inspection', { p_job: body.jobId, p_template: body.templateId, p_title: body.title, p_area: body.area }) };
});
