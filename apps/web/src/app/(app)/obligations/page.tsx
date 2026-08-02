import { PageHeader } from '@/components/ui';
import { requirePagePermission } from '@/lib/rbac/page-guard';
import { ObligationsDashboard } from './obligations-dashboard';

export const metadata = {
  title: 'Renewals & Obligations',
};

/**
 * Unified Renewals & Obligations Calendar — one screen of every date-driven
 * obligation across the platform (leases, debt, covenants, insurance, subscriptions,
 * vendor compliance, recurring invoices) so nothing lapses. Read-only aggregate.
 *
 * Page-level RBAC: gated on the existing `reports:view` permission (fails closed —
 * an unauthorized role is redirected before any client JS ships).
 */
export default async function ObligationsPage() {
  await requirePagePermission('reports', 'view');

  return (
    <>
      <PageHeader
        title="Renewals & Obligations"
        description="Every date-driven obligation across the platform in one calendar — lease term-ends, debt maturities and payments, covenant tests, insurance and subscription renewals, vendor W-9/COI expirations, and recurring invoices — ranked by urgency so nothing lapses."
      />
      <ObligationsDashboard />
    </>
  );
}
