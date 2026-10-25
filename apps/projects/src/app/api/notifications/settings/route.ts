export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { companiesWith } from '@/lib/access/can';
import { companySettings, configureCompany } from '@/lib/notify/inbox';
import { emailConfig } from '@/lib/notify/email';
import { pushConfig } from '@/lib/notify/push';
import { smsConfig } from '@/lib/notify/sms';
import { SettingsBody, SettingsQuery } from '@/lib/notify/schemas';

/**
 * GET /api/notifications/settings[?companyId] — per company: customer go-live, texting, caps,
 * mandatory events, quiet hours; plus which providers the host has configured.
 */
export const GET = route({ access: { cap: 'projects.settings', action: 'configure' }, query: SettingsQuery, mask: false }, async ({ db, access, query }) => {
  const mine = companiesWith(access, 'projects.settings', 'configure');
  const ids = query.companyId ? mine.filter((c) => c === query.companyId) : mine;
  return {
    companies: await companySettings(db, ids),
    providers: { email: emailConfig().configured, sms: smsConfig().configured, push: pushConfig().configured },
  };
});

/** PUT /api/notifications/settings { companyId, patch } — checked at that company (route + pm.notify_configure). */
export const PUT = route({ access: { cap: 'projects.settings', action: 'configure' }, body: SettingsBody, mask: false }, async ({ db, body }) => {
  return configureCompany(db, body.companyId, body.patch);
});
