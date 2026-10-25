export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { HttpError } from '@/lib/api-errors';
import { assertCompany, route } from '@/lib/api';
import { loadSell } from '../_lib/phone-reads';

/**
 * GET /api/field/sell?workOrderId= — the kitchen-table close on the phone: the visit's
 * good / better / best options with the regular and member price, rebates, the add-on lines, the
 * financing plans (APR, term, promo; never the dealer fee) and the membership plans. These are
 * the CUSTOMER-FACING prices the technician presents (mask: false like /api/fieldservice/estimates);
 * item cost is never selected. The sale itself is queued as an `fs.sell` command (POST /api/field/sync).
 */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ workOrderId: z.string().uuid() }) }, async ({ db, tenant, query }) => {
  const b = await loadSell(db, query.workOrderId);
  if (!b) throw new HttpError(404, 'That visit was not found, or it is not yours.', 'NOT_FOUND');
  assertCompany(tenant, b.companyId);
  return b;
});
