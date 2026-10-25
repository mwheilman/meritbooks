export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { cmError, cmRpc } from '@/lib/commercial/server';

/** GET /api/commercial/directory?jobId= — the project directory with trade data (CSI divisions, union, DBE/MBE/WBE, EMR, prequal). */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ jobId: Uuid }) }, async ({ db, query }) => {
  const res = await db.schema('pm').from('cm_v_project_directory').select('*').eq('job_id', query.jobId).order('party_role').order('company_name');
  if (res.error) throw cmError(res.error);
  return { entries: res.data ?? [] };
});

/** POST /api/commercial/directory — fill the directory from the job (owner, subcontractors on commitments, team). */
export const POST = route({ access: { cap: 'projects.jobs', action: 'edit' }, mask: false, body: z.object({ jobId: Uuid }) }, async ({ db, body }) => {
  return { added: await cmRpc<number>(db, 'cm_seed_project_directory', { p_job: body.jobId }) };
});
