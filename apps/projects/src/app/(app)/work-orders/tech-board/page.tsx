import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { OneCompany } from '@/components/dealer/common/depth';
import { TechBoard } from '@/components/dealer/service/TechBoard';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Tech board' };
export const dynamic = 'force-dynamic';

/** Clock on repair-order lines, indirect time, flag hours, and productivity by tech. */
export default async function TechBoardPage() {
  const o = await dealerScope();
  if (!o) return null;
  await guardPage('/work-orders');
  if (!o.dealerIds.length) {
    return (
      <Page>
        <PageHead eyebrow={o.where} title="Tech board" />
        <StoreOff title="Tech board" what="Clock on repair-order lines, indirect time, flag hours, and productivity by tech." />
      </Page>
    );
  }
  const companyId = o.writeCompanyId;
  return (
    <>
      <PageLine facts={[o.where, { label: 'Tech board', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Tech board" actions={<ButtonLink variant="quiet" href="/work-orders">Repair orders</ButtonLink>} />
        {companyId ? <TechBoard companyId={companyId} today={todayIso()} /> : <OneCompany what="Tech board" />}
      </Page>
    </>
  );
}
