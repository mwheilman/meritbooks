export const dynamic = 'force-dynamic';

import { z } from 'zod';
import { route } from '@/lib/api';
import { bellPayload, listInbox } from '@/lib/notify/inbox';
import { InboxQuery } from '@/lib/notify/schemas';

const Query = InboxQuery.extend({ view: z.enum(['bell', 'inbox']).default('bell') });

/**
 * GET /api/notifications — the bell: { unread, needsYou, items } (latest, not done).
 * GET /api/notifications?view=inbox&filter=unread|all|done&before=…&jobId=… — one inbox page.
 * The caller's own rows only (RLS); text is already masked per recipient by the database, so
 * there is no money key to strip (mask: false).
 */
export const GET = route({ access: 'none', query: Query, mask: false }, async ({ db, query }) => {
  if (query.view === 'inbox') return listInbox(db, { filter: query.filter, before: query.before ?? null, jobId: query.jobId ?? null, limit: query.limit });
  return bellPayload(db, query.limit ?? 12);
});
