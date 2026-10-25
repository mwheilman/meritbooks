export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { SubmittalCreate } from '@/lib/commercial/schemas';
import { cmRpc, cmWrote, loadSubmittals } from '@/lib/commercial/server';

/** GET /api/commercial/submittals?jobId= — the submittal register. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ jobId: Uuid }) }, async ({ db, query }) => {
  return { submittals: await loadSubmittals(db, [query.jobId]) };
});

/** POST /api/commercial/submittals — import spec sections, generate the register from them (CGC-62, CGC-65), or add one by hand. */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, ops: { import_specs: { cap: 'projects.documents', action: 'create' } }, mask: false, body: SubmittalCreate }, async ({ db, body }) => {
  switch (body.op) {
    case 'import_specs':
      return { imported: await cmRpc<number>(db, 'cm_import_spec_sections', { p_job: body.jobId, p_sections: body.sections.map((x) => ({ number: x.section, title: x.title })) }) };
    case 'generate':
      return { generated: await cmRpc<number>(db, 'cm_generate_submittal_register', { p_job: body.jobId }) };
    case 'create':
      return cmWrote<{ id: string; number: string }>(await db.schema('pm').from('cm_submittals').insert({
        job_id: body.jobId, title: body.title, spec_section: body.specSection, submittal_type: body.submittalType, required_on_site: body.requiredOnSite,
        lead_time_days: body.leadTimeDays, review_days: body.reviewDays, responsible_vendor_id: body.responsibleVendorId,
      }).select('id, number').single());
  }
});
