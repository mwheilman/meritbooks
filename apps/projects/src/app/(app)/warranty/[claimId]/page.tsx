import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { ClaimBuilder } from '@/components/dealer/warranty/ClaimBuilder';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Warranty claim' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One claim: every field the manufacturer needs, the parts, the filing packet and the answer. */
export default async function WarrantyClaimPage({ params }: { params: { claimId: string } }) {
  if (!UUID.test(params.claimId)) notFound();
  const o = await dealerScope();
  if (!o) return null;
  await guardPage('/warranty');
  if (!o.dealerIds.length) {
    return (
      <Page>
        <PageHead eyebrow={o.where} title="Warranty claim" />
        <StoreOff title="Warranty claim" what="One claim: every field the manufacturer needs, the parts, the filing packet and the answer." />
      </Page>
    );
  }
  return (
    <>
      <PageLine facts={[o.where, { label: 'Warranty claim', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Warranty claim" actions={<ButtonLink variant="quiet" href="/warranty">Warranty</ButtonLink>} />
        <ClaimBuilder claimId={params.claimId} today={todayIso()} />
      </Page>
    </>
  );
}
