import { PageHeader } from '@/components/ui';
import { CompanyScopeGuard } from '@/components/company-scope-guard';
import { HubTabs } from '../_components/hub-tabs';
import { LeasesDashboard } from './leases-dashboard';

export const metadata = {
  title: 'Leases',
};

export default function LeasesPage() {
  return (
    <>
      <PageHeader
        title="Lease Management"
        description="ASC 842 — drop a lease agreement, confirm the extracted terms, and MeritBooks sets up the right-of-use asset, the lease liability, and the amortization schedule, then posts each period on demand"
      />
      <HubTabs section="assets" />
      <CompanyScopeGuard>
        <LeasesDashboard />
      </CompanyScopeGuard>
    </>
  );
}
