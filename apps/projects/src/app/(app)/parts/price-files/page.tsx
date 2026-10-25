import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { OneCompany } from '@/components/dealer/common/depth';
import { PriceFilesView } from '@/components/dealer/parts/PriceFilesView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Price files' };
export const dynamic = 'force-dynamic';

/** OEM parts price files and supersessions: stage, review what changes, apply. */
export default async function PriceFilesPage() {
  const o = await dealerScope();
  if (!o) return null;
  await guardPage('/parts');
  if (!o.dealerIds.length) {
    return (
      <Page>
        <PageHead eyebrow={o.where} title="Price files" />
        <StoreOff title="Price files" what="Manufacturer parts price files: list and cost changes, new parts and supersessions, reviewed before they reach the counter." />
      </Page>
    );
  }
  return (
    <>
      <PageLine facts={[o.where, { label: 'OEM price files', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Price files" actions={<ButtonLink variant="quiet" href="/parts">Parts</ButtonLink>} />
        {o.writeCompanyId ? <PriceFilesView companyId={o.writeCompanyId} today={todayIso()} /> : <OneCompany what="Price files" />}
      </Page>
    </>
  );
}
