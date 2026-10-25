export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { cmRpc } from '@/lib/commercial/server';

/** GET /api/commercial/executive?companyId= — the executive roll-up (contract, billed, earned, backlog, exposure, fades, document control, billing). */
export const GET = route({ access: { cap: 'projects.financials', action: 'view' }, mask: ['job', 'billing', 'change_order'], query: z.object({ companyId: Uuid.optional() }) }, async ({ db, query }) => {
  return cmRpc<Record<string, unknown>>(db, 'cm_executive_summary', { p_location: query.companyId ?? null });
});
