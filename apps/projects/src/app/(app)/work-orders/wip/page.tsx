import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { WipView } from '@/components/dealer/completion/ServiceBoards';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Service WIP' };
export const dynamic = 'force-dynamic';

/** Open ROs at cost, days open, the month-end cutoff list, and units waiting for pickup. */
export default async function WorkOrdersWipPage() {
  return (
    <DealerShell guard="/work-orders/wip" title="Service WIP" what="Open ROs at cost, days open, the month-end cutoff list, and units waiting for pickup." actions={<ButtonLink variant="quiet" href="/work-orders/service">Service desk</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      return <WipView companyId={companyId} today={today} />;
      }}
    </DealerShell>
  );
}
