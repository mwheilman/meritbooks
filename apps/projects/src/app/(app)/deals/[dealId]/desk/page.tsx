import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { DeskWorksheet } from '@/components/dealer/deals/DeskWorksheet';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Deal desk' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Gross, the margin floor and its approval, payment options side by side, and delivery blockers. */
export default async function DealDeskPage({ params }: { params: { dealId: string } }) {
  if (!UUID.test(params.dealId)) notFound();
  const o = await dealerScope();
  if (!o) return null;
  await guardPage('/deals');
  if (!o.dealerIds.length) {
    return (
      <Page>
        <PageHead eyebrow={o.where} title="Deal desk" />
        <StoreOff title="Deal desk" what="Gross, the margin floor and its approval, payment options side by side, and delivery blockers." />
      </Page>
    );
  }
  return (
    <>
      <PageLine facts={[o.where, { label: 'Deal desk', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Deal desk" actions={<><ButtonLink variant="quiet" href={`/deals/${params.dealId}/menu`}>Payment menu</ButtonLink><ButtonLink variant="quiet" href="/deals">Deals</ButtonLink></>} />
        <DeskWorksheet dealId={params.dealId} />
      </Page>
    </>
  );
}
