import type { Metadata } from 'next';
import { Page, PageHead, count, money, ButtonLink } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { loadPipeline } from '@/lib/pm/dealer/deal-queries';
import { loadStock } from '@/lib/pm/dealer/unit-queries';
import { DEAL_STAGES, type DealStage } from '@/lib/pm/dealer/types';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { DealsPipeline } from '@/components/dealer/deals/DealsPipeline';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Deals' };
export const dynamic = 'force-dynamic';

/** The sales desk: every deal by stage with its front, back and total gross. */
export default async function DealsPage({ searchParams }: { searchParams: { stage?: string; new?: string } }) {
  const o = await dealerScope();
  if (!o) return null;
  if (!o.dealerIds.length) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title="Deals" />
          <StoreOff title="The sales desk" what="Quotes, buyer’s orders, trades, F&I and delivery on whole-goods deals, desked against your margin floor." />
        </Page>
      </>
    );
  }
  const [deals, stock] = await Promise.all([loadPipeline(o.db, o.dealerIds), loadStock(o.db, o.dealerIds)]);
  const toDesk = deals.filter((d) => d.stage === 'WRITTEN');
  const delivered30 = deals.filter((d) => d.stage === 'DELIVERED' && d.delivered_on && Date.parse(d.delivered_on) >= Date.now() - 30 * 86_400_000);
  const stage = DEAL_STAGES.find((s) => s === searchParams.stage);
  return (
    <>
      <PageLine
        facts={[
          o.where,
          { label: `${count(toDesk.length)} to desk`, strong: toDesk.length > 0 },
          `${count(deals.filter((d) => d.stage === 'FUNDED').length)} to deliver`,
          { label: `${money(delivered30.reduce((s, d) => s + (d.total_gross_cents ?? 0), 0), { decimals: 0 })} gross delivered in 30 days`, tnum: true },
        ]}
      />
      <Page>
        <PageHead eyebrow={o.where} title="Deals" actions={<ButtonLink variant="quiet" href="/stock/settings">Store settings</ButtonLink>} />
        <DealsPipeline
          deals={deals}
          units={stock.units}
          companies={o.dealerCompanies}
          writeCompanyId={o.writeCompanyId}
          multi={o.dealerIds.length > 1}
          initialBand={stage && stage !== 'LOST' ? (stage as Exclude<DealStage, 'LOST'>) : null}
          openNew={searchParams.new === '1'}
        />
      </Page>
    </>
  );
}
