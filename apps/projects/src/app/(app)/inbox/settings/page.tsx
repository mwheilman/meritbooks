import type { Metadata } from 'next';
import { Page, PageHead, WidgetState } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { loadPrefs } from '@/lib/notify/inbox';
import type { NotificationPrefs } from '@/lib/notify/types';
import { PageLine } from '@/components/common/PageLine';
import { guardPage } from '@/components/shell/page-guard';
import { PreferencesForm } from '@/components/notifications/PreferencesForm';

export const metadata: Metadata = { title: 'Notification settings' };
export const dynamic = 'force-dynamic';

/** Inbox → Settings (PLT-46): what reaches me, on which channel, digest cadence, quiet hours, work texts. */
export default async function NotificationSettingsPage() {
  const scope = await pageScope();
  if (!scope) return null;
  const { access } = await guardPage('/inbox');
  const db = await requireDb();
  let prefs: NotificationPrefs | null = null;
  let error: string | null = null;
  try {
    prefs = await loadPrefs(db, access);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Your settings did not load.';
  }
  return (
    <>
      <PageLine facts={[{ label: 'Notification settings', strong: true }]} />
      <Page>
        <PageHead eyebrow={['Inbox', 'Settings']} title="Notification settings">
          Your role sets the starting point. Change any cell; required ones are locked by your company.
        </PageHead>
        {prefs ? (
          <PreferencesForm initial={prefs} roleTitle={access.title} />
        ) : (
          <div className="mp-table" style={{ padding: 16 }}>
            <WidgetState state={{ kind: 'error', title: 'Your settings did not load', body: error ?? undefined }} />
          </div>
        )}
      </Page>
    </>
  );
}
