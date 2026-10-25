import type { Metadata } from 'next';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { PageLine } from '@/components/common/PageLine';
import { PortalStaffView } from '@/components/portal/staff/PortalStaffView';

export const metadata: Metadata = { title: 'Portals' };
export const dynamic = 'force-dynamic';

/**
 * Portals (1118), staff side: warranty / service requests customers sent from the portal, and who
 * has customer, sub, lender and investor access. Invitations start from a job, customer or vendor
 * (PortalAccessPanel). Every row comes through RLS: only the companies and parties the caller sees.
 */
export default async function PortalAccessPage() {
  const scope = await pageScope();
  if (!scope) return null;
  const where = scope.company?.name ?? 'All companies';
  return (
    <>
      <PageLine facts={[where, { label: 'Customer, sub and lender portals', strong: true }]} />
      <Page>
        <PageHead eyebrow={where} title="Portals" />
        <PortalStaffView companyId={scope.company?.id ?? null} />
      </Page>
    </>
  );
}
