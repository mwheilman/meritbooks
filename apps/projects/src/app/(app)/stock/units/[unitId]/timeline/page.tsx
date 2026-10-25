import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { UnitTimeline } from '@/components/dealer/stock/UnitTimeline';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Unit timeline' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One unit's whole life, newest first. */
export default async function UnitTimelinePage({ params }: { params: { unitId: string } }) {
  if (!UUID.test(params.unitId)) notFound();
  const o = await dealerScope();
  if (!o) return null;
  await guardPage('/stock');
  if (!o.dealerIds.length) {
    return (
      <Page>
        <PageHead eyebrow={o.where} title="Unit timeline" />
        <StoreOff title="Unit timeline" what="One unit's whole life, newest first." />
      </Page>
    );
  }
  return (
    <>
      <PageLine facts={[o.where, { label: 'Unit timeline', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Unit timeline" actions={<ButtonLink variant="quiet" href="/stock">Stock</ButtonLink>} />
        <UnitTimeline unitId={params.unitId} today={todayIso()} />
      </Page>
    </>
  );
}
