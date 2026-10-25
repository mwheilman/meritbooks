import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { customerOpts } from '@/lib/dealer/page-data';
import { RoutesView } from '@/components/dealer/completion/ServiceBoards';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Truck route' };
export const dynamic = 'force-dynamic';

/** Pickups and deliveries for a day, in the order the truck runs them. */
export default async function WorkOrdersRoutesPage() {
  return (
    <DealerShell guard="/work-orders/routes" title="Truck route" what="Pickups and deliveries for a day, in the order the truck runs them." actions={<ButtonLink variant="quiet" href="/work-orders/service">Service desk</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      const customers = await customerOpts(o.db);
      return <RoutesView companyId={companyId} today={today} customers={customers} />;
      }}
    </DealerShell>
  );
}
