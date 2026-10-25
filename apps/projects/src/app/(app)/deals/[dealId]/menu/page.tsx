import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PaymentMenuView } from '@/components/dealer/completion/DealFinanceViews';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Payment menu' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The customer's payment menu for one deal: every program side by side at several down payments, and the incentives that apply. */
export default async function DealMenuPage({ params }: { params: { dealId: string } }) {
  const o = await dealerScope();
  if (!o) return null;
  await guardPage('/deals');
  if (!UUID.test(params.dealId)) notFound();
  const pm = o.db.schema('pm');
  const [d, q] = await Promise.all([
    pm.from('dealer_deals').select('id, number, stage, location_id').eq('id', params.dealId).maybeSingle(),
    pm.from('dealer_quotes').select('id').eq('deal_id', params.dealId).eq('status', 'ISSUED').order('version', { ascending: false }).limit(1).maybeSingle(),
  ]);
  const deal = d.data as { id: string; number: string; stage: string; location_id: string } | null;
  if (!deal) notFound();
  return (
    <>
      <PageLine facts={[o.where, { label: `Deal ${deal.number}`, strong: true }, 'Payment menu']} />
      <Page>
        <PageHead eyebrow={`Deal ${deal.number}`} title="Payment menu" actions={<><ButtonLink variant="quiet" href={`/deals/${deal.id}/desk`}>Deal desk</ButtonLink><ButtonLink variant="quiet" href="/deals/funding">Contracts in transit</ButtonLink></>} />
        <PaymentMenuView dealId={deal.id} quoteId={(q.data as { id: string } | null)?.id ?? null} today={todayIso()} />
      </Page>
    </>
  );
}
