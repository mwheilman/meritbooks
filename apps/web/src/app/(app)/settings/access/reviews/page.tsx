import { PageHeader } from '@/components/ui';
import { AccessReviewsClient } from './reviews-client';

export const metadata = { title: 'Access reviews' };

export const dynamic = 'force-dynamic';

/**
 * Access reviews / recertification (05-RBAC-SPEC §6.8 A8): start a campaign (everyone, one
 * client, or one role), let each reviewer keep / reduce / revoke the access they're shown,
 * watch progress against the due date, and close it out with a completion report for
 * auditors.
 *
 * NO LEGACY PAGE GUARD on purpose: reviewers are each person's grantor or manager, who may
 * hold no legacy admin key. Authority is the database — RLS shows a reviewer only their own
 * items (access admins see everything), and every decision runs through
 * core.access_review_decide (reviewer or access admin; never your own access).
 */
export default function AccessReviewsPage() {
  return (
    <>
      <PageHeader
        title="Access reviews"
        description="Confirm that everyone still needs the access they have. Revoking here takes effect immediately and is recorded in the access log."
        breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Access' }, { label: 'Reviews' }]}
      />
      <AccessReviewsClient />
    </>
  );
}
