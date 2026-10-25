import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { contractOpts } from '@/lib/dealer/page-data';
import { RentalFleetView } from '@/components/dealer/completion/RentalFleetView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Rental fleet' };
export const dynamic = 'force-dynamic';

/** Contract-out paperwork, availability across stores, blocks, fleet service and short-rental rates. */
export default async function RentalsFleetPage() {
  return (
    <DealerShell guard="/rentals/fleet" title="Rental fleet" what="Contract-out paperwork, availability across stores, blocks, fleet service and short-rental rates." actions={<ButtonLink variant="quiet" href="/rentals">Rentals</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      const [contracts, returned] = await Promise.all([contractOpts(o.db, companyId, ['RESERVED']), contractOpts(o.db, companyId, ['RETURNED', 'CLOSED'])]);
      return <RentalFleetView companyId={companyId} today={today} contracts={contracts} returned={returned.slice(0, 50)} />;
      }}
    </DealerShell>
  );
}
