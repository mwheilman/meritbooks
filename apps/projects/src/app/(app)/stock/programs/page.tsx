import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { OneCompany } from '@/components/dealer/common/depth';
import { ProgramsView } from '@/components/dealer/settings/ProgramsView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Programs and interfaces' };
export const dynamic = 'force-dynamic';

/** Finance programs, standard fees, parts catalogs and OEM interfaces. */
export default async function ProgramsAndInterfacesPage() {
  const o = await dealerScope();
  if (!o) return null;
  await guardPage('/stock');
  if (!o.dealerIds.length) {
    return (
      <Page>
        <PageHead eyebrow={o.where} title="Programs and interfaces" />
        <StoreOff title="Programs and interfaces" what="Finance programs, standard fees, parts catalogs and OEM interfaces." />
      </Page>
    );
  }
  const companyId = o.writeCompanyId;
  return (
    <>
      <PageLine facts={[o.where, { label: 'Programs and interfaces', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Programs and interfaces" actions={<ButtonLink variant="quiet" href="/stock/settings">Store settings</ButtonLink>} />
        {companyId ? <ProgramsView companyId={companyId} today={todayIso()} /> : <OneCompany what="Programs and interfaces" />}
      </Page>
    </>
  );
}
