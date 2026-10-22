export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, must, route } from '@/lib/api';
import { listCostCodes } from '@/lib/pm/budget';

const Query = z.object({ companyId: z.string().uuid(), inactive: z.enum(['1', '0']).optional() });
const Body = z.object({
  companyId: z.string().uuid(),
  code: z.string().trim().min(1, 'Give it a code').max(24),
  name: z.string().trim().min(1, 'Give it a name').max(80),
  costType: z.enum(['LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT', 'OTHER']),
});

export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: Query }, async ({ db, query, tenant }) => {
  assertCompany(tenant, query.companyId);
  return { costCodes: await listCostCodes(db, query.companyId, { includeInactive: query.inactive === '1' }) };
});

/** Add a tenant cost code to the company library (pack codes come from the pack). */
export const POST = route({ access: { cap: 'projects.settings', action: 'configure' }, mask: false, body: Body }, async ({ db, body, tenant }) => {
  assertCompany(tenant, body.companyId);
  const last = must(await db.schema('pm').from('cost_codes').select('sort').eq('location_id', body.companyId).is('job_id', null).order('sort', { ascending: false }).limit(1), 'last code') as Array<{ sort: number }>;
  const row = must(
    await db.schema('pm').from('cost_codes').insert({
      location_id: body.companyId, job_id: null, code: body.code, name: body.name, cost_type: body.costType, sort: (last[0]?.sort ?? -1) + 1,
    }).select('id').single(),
    'add cost code',
  ) as { id: string };
  return { costCodeId: row.id };
});
