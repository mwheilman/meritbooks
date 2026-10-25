import type { Metadata } from 'next';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { customerOpts } from '@/lib/dealer/page-data';
import { Customer360View } from '@/components/dealer/completion/StoreViews';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Customer 360' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One customer across the store: equipment, service, deals, rentals, special orders, texts and receivables. */
export default async function StockCustomersPage({ searchParams }: { searchParams: { wo?: string; customer?: string } }) {
  return (
    <DealerShell guard="/stock/customers" title="Customer 360" what="One customer across the store: equipment, service, deals, rentals, special orders, texts and receivables.">
      {async ({ companyId, o, today }) => {
      const customers = await customerOpts(o.db);
      const c = searchParams.customer && UUID.test(searchParams.customer) ? searchParams.customer : null;
      return <Customer360View companyId={companyId} today={today} customers={customers} initial={c} />;
      }}
    </DealerShell>
  );
}
