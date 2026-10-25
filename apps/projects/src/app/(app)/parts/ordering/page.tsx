import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { vendorOpts, stockLocationOpts } from '@/lib/dealer/page-data';
import { OrderingView } from '@/components/dealer/completion/PartsViews';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Stock ordering' };
export const dynamic = 'force-dynamic';

/** Suggested min / max from demand and lost sales, the stock order, the distributor file, acknowledgments, backorders and special-order texts. */
export default async function PartsOrderingPage() {
  return (
    <DealerShell guard="/parts/ordering" title="Stock ordering" what="Suggested min / max from demand and lost sales, the stock order, the distributor file, acknowledgments, backorders and special-order texts." actions={<ButtonLink variant="quiet" href="/parts">Parts</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      const [vendors, sl, orders] = await Promise.all([vendorOpts(o.db), stockLocationOpts(o.db, [companyId]),
        o.db.schema('pm').from('parts_orders').select('id, number, status, vendor_id').eq('location_id', companyId).in('status', ['DRAFT', 'SUBMITTED', 'PARTIAL']).order('created_at', { ascending: false }).limit(100)]);
      return <OrderingView companyId={companyId} today={today} stockLocations={sl} vendors={vendors.map((v) => ({ id: v.id, name: v.label }))} openOrders={(orders.data ?? []) as Array<{ id: string; number: string; status: string; vendor_id: string | null }>} />;
      }}
    </DealerShell>
  );
}
