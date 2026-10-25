import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { OneCompany } from '@/components/dealer/common/depth';
import { CreditsView } from '@/components/dealer/warranty/CreditsView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Warranty deadlines' };
export const dynamic = 'force-dynamic';

/** Claims to file, answers due, parts to keep, and OEM credit memos to match. */
export default async function WarrantyDeadlinesPage() {
  const o = await dealerScope();
  if (!o) return null;
  await guardPage('/warranty');
  if (!o.dealerIds.length) {
    return (
      <Page>
        <PageHead eyebrow={o.where} title="Warranty deadlines" />
        <StoreOff title="Warranty deadlines" what="Claims to file, answers due, parts to keep, and OEM credit memos to match." />
      </Page>
    );
  }
  const companyId = o.writeCompanyId;
  return (
    <>
      <PageLine facts={[o.where, { label: 'Warranty deadlines', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Warranty deadlines" actions={<ButtonLink variant="quiet" href="/warranty">Warranty</ButtonLink>} />
        {companyId ? <CreditsView companyId={companyId} today={todayIso()} /> : <OneCompany what="Warranty deadlines" />}
      </Page>
    </>
  );
}
