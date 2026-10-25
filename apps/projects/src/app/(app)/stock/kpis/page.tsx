import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { OneCompany } from '@/components/dealer/common/depth';
import { KpiBoard } from '@/components/dealer/stock/KpiBoard';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Store scorecard' };
export const dynamic = 'force-dynamic';

/** The dealer scorecard: counter, service, warranty, units and rentals. */
export default async function StoreScorecardPage() {
  const o = await dealerScope();
  if (!o) return null;
  await guardPage('/stock');
  if (!o.dealerIds.length) {
    return (
      <Page>
        <PageHead eyebrow={o.where} title="Store scorecard" />
        <StoreOff title="Store scorecard" what="The dealer scorecard: counter, service, warranty, units and rentals." />
      </Page>
    );
  }
  const companyId = o.writeCompanyId;
  return (
    <>
      <PageLine facts={[o.where, { label: 'Store scorecard', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Store scorecard" actions={<ButtonLink variant="quiet" href="/stock">Stock</ButtonLink>} />
        {companyId ? <KpiBoard companyId={companyId} today={todayIso()} /> : <OneCompany what="Store scorecard" />}
      </Page>
    </>
  );
}
