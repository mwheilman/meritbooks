export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { listProjects } from '@/lib/pm/projects';
import { searchCustomers } from '@/lib/pm/people';
import { getScope } from '@/lib/scope';

/** ⌘K: jobs and customers matching a term, inside the current scope. */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ q: z.string().max(80).default('') }) }, async ({ db, query, tenant }) => {
  const s = await getScope();
  const companyIds = s.kind === 'ready' ? s.scope.companyIds : tenant.companies.map((c) => c.id);
  const names = new Map(tenant.companies.map((c) => [c.id, c.name]));
  if (query.q.trim().length < 2) return { jobs: [], customers: [] };
  const [jobs, customers] = await Promise.all([
    listProjects(db, { companyIds, q: query.q, perPage: 8 }),
    searchCustomers(db, query.q, tenant.activeCompanyId, 5),
  ]);
  return {
    jobs: jobs.rows.map((j) => ({
      id: j.job_id, number: j.job_number, name: j.name, customer: j.customer_name, stage: j.stage_label,
      company: companyIds.length > 1 ? names.get(j.location_id) ?? null : null,
    })),
    customers: customers.map((c) => ({ id: c.id, name: c.display_name || c.name })),
  };
});
