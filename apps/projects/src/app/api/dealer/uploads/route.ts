export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { storeUpload } from '@/lib/dealer/upload';

/**
 * POST /api/dealer/uploads — one photo, signature image or shipment file from the yard, the counter
 * or the service lane (damage on receipt, lot scan, RO finding, check-in, pickup, rental paperwork).
 * Returns the document id the 1125 operation then stores.
 */
export const POST = route({ access: { cap: 'projects.store', action: 'edit' }, mask: false }, async ({ req, db, tenant, userId }) =>
  storeUpload(req, db, { orgId: tenant.orgId, userId }, { area: 'dealer/1125', entityType: 'pm.dealer_upload' }));
