import { requirePagePermission } from '@/lib/rbac/page-guard';
import { PageHeader } from '@/components/ui';
import { AccessLogClient } from './log-client';

export const metadata = { title: 'Access log' };

export const dynamic = 'force-dynamic';

/**
 * Access log (05-RBAC-SPEC §5.5, §6.9 A9): every change to who can do what — grants,
 * removals, end dates, role publishes, reviews, requests — append-only, filterable, and
 * exportable as CSV for auditors.
 *
 * PAGE GUARD: audit_trail:view (legacy key until the wave-2 flip). The data route
 * (/api/access/log) additionally enforces the 166 RLS policy: tenant admins and holders of
 * ctl.audit_trail:view or core.access.reviews:view.
 */
export default async function AccessLogPage() {
  await requirePagePermission('audit_trail', 'view');
  return (
    <>
      <PageHeader
        title="Access log"
        description="Every change to who can do what, when, by whom and why. Nothing here can be edited or deleted."
        breadcrumbs={[{ label: 'Settings', href: '/settings' }, { label: 'Access' }, { label: 'Log' }]}
      />
      <AccessLogClient />
    </>
  );
}
