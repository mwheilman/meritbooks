import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { loadWarranty } from '@/lib/pm/dealer/store-queries';
import { WARRANTY_BANDS } from '@/lib/pm/dealer/labels';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { WarrantyView } from '@/components/dealer/warranty/WarrantyView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Warranty' };
export const dynamic = 'force-dynamic';

/** Manufacturer warranty claims: what is owed, what is due to file, and how Merit Books settled them. */
export default async function WarrantyPage({ searchParams }: { searchParams: { band?: string } }) {
  const o = await dealerScope();
  if (!o) return null;
  const { money: mv } = await guardPage('/warranty');
  if (!o.dealerIds.length) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title="Warranty" />
          <StoreOff title="Warranty" what="Manufacturer claims from repair orders, their filing deadlines, and the credits, short-pays and rejections Merit Books records." />
        </Page>
      </>
    );
  }
  const data = await loadWarranty(o.db, o.dealerIds);
  const owed = data.open.filter((c) => c.status !== 'DRAFT').reduce((s, c) => s + c.outstanding_cents, 0);
  const atRisk = data.open.filter((c) => c.deadline_at_risk).length;
  const band = WARRANTY_BANDS.find((b) => b.value === searchParams.band)?.value ?? null;
  return (
    <>
      <PageLine facts={[o.where, mv.contract ? { label: `${money(owed, { decimals: 0 })} owed by manufacturers`, strong: true, tnum: true } : { label: 'Warranty claims', strong: true }, ...(atRisk ? [`${count(atRisk)} near the filing deadline`] : [])]} />
      <Page>
        <PageHead eyebrow={o.where} title="Warranty" actions={<ButtonLink variant="quiet" href="/work-orders?view=claims">Claims by repair order</ButtonLink>} />
        <WarrantyView data={data} booksPresent={o.scope.tenant.booksPresent} today={todayIso()} initialBand={band} />
      </Page>
    </>
  );
}
