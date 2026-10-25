export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { loadRo } from '../_lib/phone-reads';

/**
 * GET /api/field/ro — dealer technician: open repair orders at my stores (the ones dispatched to me
 * first), their labor lines (description, labor op, flat-rate hours) and my open punch. Clock on /
 * off / indirect and the 3C story are queued as `ro.clock` / `ro.story` commands. No prices.
 */
export const GET = route({ access: { cap: 'projects.time', action: 'create' }, mask: ['repair_order', 'time_entry'] }, async ({ db, tenant, access, userId }) =>
  loadRo(db, tenant, access, userId));
