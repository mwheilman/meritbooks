import { requirePagePermission } from '@/lib/rbac/page-guard';
import { InboxTabs } from './inbox-tabs';

export const metadata = {
  title: 'Inbox',
};

/**
 * INBOX — the single "Needs you" screen. Consolidates the former Action Inbox
 * (/inbox), Needs Attention (/exceptions), and Flagged Items (/flagged) surfaces
 * into one tabbed shell: Approvals / Exceptions / Alerts / Drafts. The Exceptions
 * tab preserves the safe inline-resolve behavior from the old /exceptions screen.
 *
 * Page-level RBAC: gated on the existing `reports:view` permission (fails closed —
 * an unauthorized role is redirected before any client JS ships), matching the
 * sibling read-only aggregate screens.
 */
export default async function InboxPage() {
  await requirePagePermission('reports', 'view');

  return <InboxTabs />;
}
