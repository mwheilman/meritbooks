export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { markNotifications } from '@/lib/notify/inbox';
import { MarkBody } from '@/lib/notify/schemas';

/** POST /api/notifications/read { ids, state: read | unread | done | undone | read_all | done_all } → { updated }. Own rows only. */
export const POST = route({ access: 'none', body: MarkBody, mask: false, allowReadOnly: true }, async ({ db, body }) => {
  const updated = await markNotifications(db, body.ids, body.state);
  return { updated };
});
