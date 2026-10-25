import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { DrawerView } from '@/components/dealer/completion/StoreViews';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Cash drawer' };
export const dynamic = 'force-dynamic';

/** Registers, payments taken at the counter, the count-out, and the deposit batch for Books. */
export default async function StockDrawerPage() {
  return (
    <DealerShell guard="/stock/drawer" title="Cash drawer" what="Registers, payments taken at the counter, the count-out, and the deposit batch for Books." actions={<ButtonLink variant="quiet" href="/stock/close">Store close</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      return <DrawerView companyId={companyId} today={today} />;
      }}
    </DealerShell>
  );
}
