import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { vendorOpts, stockLocationOpts } from '@/lib/dealer/page-data';
import { YardView } from '@/components/dealer/completion/YardView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Yard' };
export const dynamic = 'force-dynamic';

/** Receive OEM shipments by serial, count the lot and the floor plan, finish recon. */
export default async function StockYardPage() {
  return (
    <DealerShell guard="/stock/yard" title="Yard" what="Receive OEM shipments by serial, count the lot and the floor plan, finish recon." actions={<ButtonLink variant="quiet" href="/stock">Stock</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      const [vendors, sl] = await Promise.all([vendorOpts(o.db), stockLocationOpts(o.db, [companyId])]);
      return <YardView companyId={companyId} today={today} vendors={vendors.map((v) => ({ id: v.id, name: v.label }))} stockLocations={sl} />;
      }}
    </DealerShell>
  );
}
