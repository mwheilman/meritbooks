export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { listSources } from '@/lib/templates/sources';
import { TEMPLATE_KEYS } from '@/lib/templates/types';

/** GET /api/documents/templates/sources?template=&jobId=&companyId= — records the template can be generated from (RLS). */
export const GET = route({
  access: { cap: 'projects.documents', action: 'view' }, mask: false,
  query: z.object({ template: z.enum(TEMPLATE_KEYS), jobId: z.string().uuid().optional(), companyId: z.string().uuid().optional() }),
}, async ({ db, query }) => ({ sources: await listSources(db, query.template, { jobId: query.jobId ?? null, companyId: query.companyId ?? null }) }));
