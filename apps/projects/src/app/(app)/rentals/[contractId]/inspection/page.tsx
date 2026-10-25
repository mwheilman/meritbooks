import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { InspectionView } from '@/components/dealer/rentals/InspectionView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Rental inspection' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Check-out and check-in walk-arounds compared, with the charges they suggest. */
export default async function RentalInspectionPage({ params }: { params: { contractId: string } }) {
  if (!UUID.test(params.contractId)) notFound();
  const o = await dealerScope();
  if (!o) return null;
  await guardPage('/rentals');
  if (!o.dealerIds.length) {
    return (
      <Page>
        <PageHead eyebrow={o.where} title="Rental inspection" />
        <StoreOff title="Rental inspection" what="Check-out and check-in walk-arounds compared, with the charges they suggest." />
      </Page>
    );
  }
  return (
    <>
      <PageLine facts={[o.where, { label: 'Rental inspection', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Rental inspection" actions={<ButtonLink variant="quiet" href="/rentals">Rentals</ButtonLink>} />
        <InspectionView contractId={params.contractId} today={todayIso()} />
      </Page>
    </>
  );
}
