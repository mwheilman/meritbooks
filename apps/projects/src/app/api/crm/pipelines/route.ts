export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { assertCompany, route } from '@/lib/api';
import { defaultPipeline, listPipelines } from '@/lib/crm/queries';

/** A company's lead pipelines and stages (crm.pipelines / pipeline_stages), the default first. */
export const GET = route(
  { access: { cap: 'projects.leads', action: 'view' }, mask: false, query: z.object({ companyId: z.string().uuid() }) },
  async ({ db, query, tenant }) => {
    assertCompany(tenant, query.companyId);
    const pipelines = await listPipelines(db, [query.companyId]);
    return { pipelines, defaultId: defaultPipeline(pipelines, query.companyId)?.id ?? null };
  },
);
