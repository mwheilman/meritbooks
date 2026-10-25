export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { actOnMany } from '@/lib/approvals/server';
import { BulkBody } from '../schemas';

/**
 * POST /api/approvals/bulk — approve (or send back) several at once. Each runs on its own and
 * reports per row; bulk approval only for the types the engine allows (pm.approval_bulk_types).
 */
export const POST = route({ access: 'none', mask: false, body: BulkBody }, async ({ db, body }) =>
  actOnMany(db, body.ids, body.decision, body.reason ?? null, body.channel));
