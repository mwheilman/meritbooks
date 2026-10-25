import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { OneCompany } from '@/components/dealer/common/depth';
import { CounterTools } from '@/components/dealer/parts/CounterTools';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Counter speed' };
export const dynamic = 'force-dynamic';

/** The fast counter: scan, pick lists, lost sales, ticket speed. */
export default async function CounterPage() {
  const o = await dealerScope();
  if (!o) return null;
  await guardPage('/parts');
  if (!o.dealerIds.length) {
    return (
      <Page>
        <PageHead eyebrow={o.where} title="Counter speed" />
        <StoreOff title="Counter speed" what="A scan-first counter: parts, units, repair orders and tickets in one box, catalog pick lists, lost sales and ticket speed." />
      </Page>
    );
  }
  return (
    <>
      <PageLine facts={[o.where, { label: 'Counter', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Counter speed" actions={<ButtonLink variant="quiet" href="/parts">Parts</ButtonLink>} />
        {o.writeCompanyId ? <CounterTools companyId={o.writeCompanyId} today={todayIso()} /> : <OneCompany what="Counter speed" />}
      </Page>
    </>
  );
}
