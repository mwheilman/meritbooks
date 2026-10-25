import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { listInbox } from '@/lib/notify/inbox';
import type { InboxPage } from '@/lib/notify/types';
import { can } from '@/lib/access/can';
import { PageLine } from '@/components/common/PageLine';
import { guardPage } from '@/components/shell/page-guard';
import { InboxView } from '@/components/notifications/InboxView';

export const metadata: Metadata = { title: 'Inbox' };
export const dynamic = 'force-dynamic';

/**
 * Inbox (PLT-42): the one suite inbox — Merit Projects and Merit Books notifications for the
 * signed-in person. Starts on Unread; text is masked per person by the database.
 */
export default async function InboxPageRoute() {
  const scope = await pageScope();
  if (!scope) return null;
  const { access } = await guardPage('/inbox');
  const db = await requireDb();
  let initial: InboxPage | null = null;
  let error: string | null = null;
  try {
    initial = await listInbox(db, { filter: 'unread', limit: 50 });
  } catch (e) {
    error = e instanceof Error ? e.message : 'The inbox did not load.';
  }
  const configures = can(access, 'projects.settings', 'configure');
  return (
    <>
      <PageLine facts={[{ label: initial ? `${count(initial.unread)} unread` : 'Inbox', strong: true }]} />
      <Page>
        <PageHead
          eyebrow="Notifications"
          title="Inbox"
          actions={
            <>
              {configures && <ButtonLink href="/inbox/company" variant="quiet">Company messages</ButtonLink>}
              <ButtonLink href="/inbox/settings">Settings</ButtonLink>
            </>
          }
        >
          Assignments, approvals, signatures, schedule changes and mentions, from Merit Projects and Merit Books.
        </PageHead>
        <InboxView initial={initial} initialError={error} initialFilter="unread" />
      </Page>
    </>
  );
}
