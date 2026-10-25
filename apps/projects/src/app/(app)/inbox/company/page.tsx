import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Page, PageHead, WidgetState } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { companiesWith } from '@/lib/access/can';
import { companySettings, heldMessages } from '@/lib/notify/inbox';
import { emailConfig } from '@/lib/notify/email';
import { pushConfig } from '@/lib/notify/push';
import { smsConfig } from '@/lib/notify/sms';
import type { CompanyNotifySettings, HeldMessage } from '@/lib/notify/types';
import { PageLine } from '@/components/common/PageLine';
import { guardPage } from '@/components/shell/page-guard';
import { CompanyMessaging } from '@/components/notifications/CompanyMessaging';

export const metadata: Metadata = { title: 'Company messages' };
export const dynamic = 'force-dynamic';

/**
 * Inbox → Company messages (settings holders): customer go-live per company (customer messages
 * are HELD until it flips), the held queue (release / discard), texting, caps, mandatory events.
 */
export default async function CompanyMessagesPage() {
  const scope = await pageScope();
  if (!scope) return null;
  const { access } = await guardPage('/inbox');
  const ids = companiesWith(access, 'projects.settings', 'configure').filter((id) => scope.tenant.companies.some((c) => c.id === id));
  if (ids.length === 0) redirect('/inbox');
  const db = await requireDb();
  let settings: CompanyNotifySettings[] = [];
  let held: HeldMessage[] = [];
  let error: string | null = null;
  try {
    [settings, held] = await Promise.all([companySettings(db, ids), heldMessages(db, ids)]);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Company messaging did not load.';
  }
  const names = Object.fromEntries(scope.tenant.companies.map((c) => [c.id, c.name]));
  return (
    <>
      <PageLine facts={[{ label: `${held.length} held`, strong: held.length > 0 }]} />
      <Page>
        <PageHead eyebrow={['Inbox', 'Company messages']} title="Company messages">
          Nothing reaches a customer until the company goes live. Texts also need the customer&rsquo;s consent.
        </PageHead>
        {error ? (
          <div className="mp-table" style={{ padding: 16 }}><WidgetState state={{ kind: 'error', title: 'Company messaging did not load', body: error }} /></div>
        ) : (
          <CompanyMessaging
            settings={settings}
            held={held}
            companyNames={names}
            providers={{ email: emailConfig().configured, sms: smsConfig().configured, push: pushConfig().configured }}
          />
        )}
      </Page>
    </>
  );
}
