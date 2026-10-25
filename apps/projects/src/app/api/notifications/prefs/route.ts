export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { loadPrefs, savePrefs } from '@/lib/notify/inbox';
import { PrefsBody } from '@/lib/notify/schemas';

/** GET /api/notifications/prefs — the caller's own channels, matrix, digest and quiet hours. */
export const GET = route({ access: 'none', mask: false }, async ({ db, access }) => loadPrefs(db, access));

/** PUT /api/notifications/prefs — save them (mandatory events cannot be narrowed; the database enforces it). */
export const PUT = route({ access: 'none', body: PrefsBody, mask: false, allowReadOnly: true }, async ({ db, access, body }) => {
  await savePrefs(db, {
    rules: body.rules, digest: body.digest, quietStart: body.quietStart, quietEnd: body.quietEnd, timezone: body.timezone,
    smsPhone: body.smsPhone, smsConsent: body.smsConsent,
  });
  return loadPrefs(db, access);
});
