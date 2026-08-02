import { PageHeader } from '@/components/ui';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { InboxClient } from './inbox-client';

export const metadata = {
  title: 'Action Inbox',
};

/**
 * ACTION INBOX — one ranked "Needs you" screen of everything waiting on the caller:
 * money-movement approvals, submitted expense reports, bills held by AP policy,
 * expense-policy-flagged drafts, open AI proposals, overdue/near-term obligations,
 * and unposted manual journal-entry drafts. Read-only aggregate; every item deep-links
 * to the record's own approve / review / post surface.
 *
 * Page-level RBAC: gated on the existing `reports:view` permission (fails closed — an
 * unauthorized role is redirected before any client JS ships), matching the sibling
 * read-only aggregate screens (Renewals & Obligations, Needs Attention).
 */
export default async function InboxPage() {
  await requirePagePermission('reports', 'view');

  return (
    <>
      <PageHeader
        title="Action Inbox"
        description="Everything that needs you, ranked — approvals and policy blocks first, then time-sensitive alerts, AI proposals, and drafts. Each item links straight to where you act on it."
      />
      <InboxClient />
    </>
  );
}
