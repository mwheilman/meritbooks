export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { pm } from '@/lib/pm/db';
import { resRpc, resWrote } from '@/lib/residential/rpc';
import { Day, Uuid } from '@/lib/residential/schemas';

export interface JobTemplateRow {
  id: string;
  key: string;
  label: string;
  contract_type: string;
  schedule_template_key: string | null;
  capitalize_to_inventory: boolean;
  deposit_pct: number | null;
  selection_list: Array<{ category: string; title: string; room: string | null }>;
  is_active: boolean;
}

/** Builder job types (RES-03) at one company. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ company: Uuid }) }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.company);
  const rows = resWrote<JobTemplateRow[]>(await pm(db).from('res_job_templates')
    .select('id, key, label, contract_type, schedule_template_key, capitalize_to_inventory, deposit_pct, selection_list, is_active').eq('location_id', query.company).order('label'));
  return { templates: rows };
});

const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('seed'), companyId: Uuid }),
  z.object({ op: z.literal('apply'), jobId: Uuid, key: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/), start: Day.nullish() }),
]);

/** seed → the five standard job types; apply → selections, schedule and GL disposition on a job. */
export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, ops: { seed: { cap: 'projects.settings', action: 'configure' }, apply: { cap: 'projects.jobs', action: 'edit' } },
  mask: false, body: Body }, async ({ db, body, tenant }) => {
  if (body.op === 'seed') {
    assertCompany(tenant, body.companyId);
    return { added: await resRpc<number>(db, 'res_seed_builder_templates', { p_location: body.companyId }) };
  }
  return resRpc(db, 'res_apply_job_template', { p_job: body.jobId, p_key: body.key, p_start: body.start ?? null });
});
