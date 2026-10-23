import { PageHeader } from '@/components/ui';
import { AccessRequestsClient } from './requests-client';

export const metadata = { title: 'Access requests' };

export const dynamic = 'force-dynamic';

/**
 * Access requests (05-RBAC-SPEC §6.11): every member can ask for access and follow their
 * requests; people who can grant it decide them here (approver inbox).
 *
 * NO PAGE GUARD on purpose — every signed-in member uses this page. Authority is the
 * database: RLS shows your own requests plus those routed to you (all of them for access
 * admins), and approval runs the delegation ceiling inside core.access_request_decide.
 */
export default function AccessRequestsPage() {
  return (
    <>
      <PageHeader
        title="Access requests"
        description="Ask for access you need, and decide requests you're able to grant."
        breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Access' }, { label: 'Requests' }]}
      />
      <AccessRequestsClient />
    </>
  );
}
