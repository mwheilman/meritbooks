export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { TemplateAction } from '@/lib/commercial/schemas';
import { cmRpc } from '@/lib/commercial/server';

/**
 * POST /api/commercial/templates — apply a project template to a job (markups, retainage
 * steps, compliance requirements, closeout list, meeting series), push a template change to
 * every job using it, or seed the commercial starter set for a company.
 */
export const POST = route({
  access: { cap: 'projects.settings', action: 'configure' },
  ops: { apply: { cap: 'projects.billing', action: 'edit' } },
  mask: false,
  body: TemplateAction,
}, async ({ db, body }) => {
  switch (body.op) {
    case 'apply':
      return cmRpc<Record<string, unknown>>(db, 'cm_apply_project_template', { p_job: body.jobId, p_template: body.templateId });
    case 'push':
      return { jobs: await cmRpc<number>(db, 'cm_push_project_template', { p_template: body.templateId }) };
    case 'seed':
      return { seeded: await cmRpc<number>(db, 'cm_seed_commercial', { p_location: body.companyId }) };
  }
});
