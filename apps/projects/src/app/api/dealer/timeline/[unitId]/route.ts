export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { xcall } from '@/lib/dealer/rpc';

/** One unit's life: received, PDI, rentals, deals and delivery, every repair order, claims, meter readings. */
export const GET = route({ access: { cap: 'projects.store', action: 'view' }, mask: ['dealer_unit', 'repair_order', 'dealer_deal'] }, async ({ db, params }) => xcall(db, 'dlr_unit_timeline', { p_unit: params.unitId! }));
