import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { stockLocationOpts } from '@/lib/dealer/page-data';
import { TransfersView } from '@/components/dealer/completion/PartsViews';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Parts locator' };
export const dynamic = 'force-dynamic';

/** On hand at every store you can see, and transfers between stores. */
export default async function PartsTransfersPage() {
  return (
    <DealerShell guard="/parts/transfers" title="Parts locator" what="On hand at every store you can see, and transfers between stores." actions={<ButtonLink variant="quiet" href="/parts">Parts</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      const sl = await stockLocationOpts(o.db, [companyId]);
      return <TransfersView companyId={companyId} today={today} myStockLocations={sl} />;
      }}
    </DealerShell>
  );
}
