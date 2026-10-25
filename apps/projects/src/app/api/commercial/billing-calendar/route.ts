export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { Uuid } from '@/lib/pm/money/schemas';
import { cmError } from '@/lib/commercial/server';

/** GET /api/commercial/billing-calendar?companyId= — every GC's cutoff, pencil due date, form and portal (multi-GC billing calendar, CGC-102). */
export const GET = route({ access: { cap: 'projects.billing', action: 'view' }, mask: ['billing'], query: z.object({ companyId: Uuid.optional() }) }, async ({ db, query }) => {
  let q = db.schema('pm').from('cm_v_billing_calendar').select('*').order('next_cutoff');
  if (query.companyId) q = q.eq('location_id', query.companyId);
  const res = await q;
  if (res.error) throw cmError(res.error);
  return { rows: res.data ?? [] };
});
