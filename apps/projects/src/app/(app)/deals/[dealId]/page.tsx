import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ButtonLink, Page, PageHead, money } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { loadDealWorkspace } from '@/lib/pm/dealer/deal-queries';
import { loadStock } from '@/lib/pm/dealer/unit-queries';
import { DEAL_STAGE } from '@/lib/pm/dealer/labels';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { DealDesk } from '@/components/dealer/deals/DealDesk';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: { dealId: string } }): Promise<Metadata> {
  const o = await dealerScope();
  if (!o || !UUID.test(params.dealId)) return { title: 'Deal' };
  const r = await o.db.schema('pm').from('dealer_deals').select('number').eq('id', params.dealId).maybeSingle();
  const n = (r.data as { number: string } | null)?.number;
  return { title: n ? `Deal ${n}` : 'Deal' };
}

/** The deal workspace: a two-column desk with live totals and the stage actions. */
export default async function DealPage({ params }: { params: { dealId: string } }) {
  if (!UUID.test(params.dealId)) notFound();
  const o = await dealerScope();
  if (!o) return null;
  const w = await loadDealWorkspace(o.db, params.dealId);
  if (!w || !o.companyIds.includes(w.deal.location_id)) notFound();
  const stock = await loadStock(o.db, [w.deal.location_id]);
  const where = o.companyName(w.deal.location_id) ?? o.where;
  return (
    <>
      <PageCrumbs items={[{ label: 'Deals', href: '/deals' }, { label: w.deal.number }]} />
      <PageLine
        facts={[
          where,
          { label: DEAL_STAGE[w.deal.stage].word, strong: true },
          { label: `${money(w.totals.total_gross_cents)} total gross`, tnum: true },
          ...(w.deal.sot_alert_at ? [{ label: 'Sold out of trust', strong: true }] : []),
        ]}
      />
      <Page>
        <PageHead
          eyebrow={[where, 'Deal']}
          title={`${w.deal.number}${w.customer ? ` · ${w.customer}` : ''}`}
          actions={<ButtonLink variant="quiet" href="/deals">All deals</ButtonLink>}
        />
        <DealDesk initial={w} stock={stock.units} today={todayIso()} />
      </Page>
    </>
  );
}
