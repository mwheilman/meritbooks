export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { loadPayWeek } from '../_lib/phone-reads';

/**
 * GET /api/field/pay?week=YYYY-MM-DD — the flooring installer's "my pay this week": their OWN
 * piece-rate tickets (lines, splits, chargebacks netted) and open chargebacks. The money is theirs:
 * pm.v_flr_pay_tickets_masked shows gross / chargeback only on the caller's own rows (1122 H1), and
 * the loader filters to the caller's employee id on top of RLS, so a supervisor who can see every
 * installer's pay still gets only their own here. mask: false so the installer's own amounts are
 * not stripped by the labor-rate key list (which is about OTHER people's rates).
 */
export const GET = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false, query: z.object({ week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) }, async ({ db, userId, query }) =>
  loadPayWeek(db, userId, query.week ?? null));
