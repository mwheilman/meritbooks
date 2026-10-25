export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { loadExceptions } from '@/lib/approvals/server';

const Q = z.object({
  companyId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** GET /api/approvals/exceptions — solo / two-person self-approvals with their typed reasons. */
export const GET = route({ access: 'none', mask: false, query: Q }, async ({ db, query, tenant }) =>
  ({ rows: await loadExceptions(db, query.companyId ?? tenant.activeCompanyId ?? null, query.from ?? null, query.to ?? null) }));
