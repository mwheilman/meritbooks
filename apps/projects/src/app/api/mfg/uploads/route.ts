export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { storeUpload } from '@/lib/dealer/upload';

/**
 * POST /api/mfg/uploads — a photo or signature from the shop or the field (site measure, punch,
 * delivery proof, install sign-off, stored materials). Returns the document id the 1125 operation
 * stores and links.
 */
export const POST = route({ access: { cap: 'projects.jobs', action: 'view' }, mask: false }, async ({ req, db, tenant, userId }) =>
  storeUpload(req, db, { orgId: tenant.orgId, userId }, { area: 'mfg/1125', entityType: 'pm.mfg_upload' }));
