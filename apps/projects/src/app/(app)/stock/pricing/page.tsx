import type { Metadata } from 'next';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { managerOpts } from '@/lib/dealer/page-data';
import { PricingView } from '@/components/dealer/completion/StoreViews';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Pricing controls' };
export const dynamic = 'force-dynamic';

/** Discount limits by role, price overrides with a reason, and manager approval. */
export default async function StockPricingPage() {
  return (
    <DealerShell guard="/stock/pricing" title="Pricing controls" what="Discount limits by role, price overrides with a reason, and manager approval.">
      {async ({ companyId, o, today }) => {
      const managers = await managerOpts(o.db, companyId);
      return <PricingView companyId={companyId} today={today} managers={managers} />;
      }}
    </DealerShell>
  );
}
