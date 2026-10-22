import type { Metadata } from 'next';
import { ButtonLink, Page, PageHead, count } from '@meritbooks/merit-ui';
import { dealerScope } from '@/lib/pm/dealer/scope';
import { loadRentals } from '@/lib/pm/dealer/store-queries';
import { parseRange } from '@/lib/pm/dealer/math';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { StoreOff } from '@/components/dealer/common/StoreOff';
import { RentalsView } from '@/components/dealer/rentals/RentalsView';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Rentals' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The rental fleet: reservations, check-out and check-in with meter and condition, billing and the rate card. */
export default async function RentalsPage({ searchParams }: { searchParams: { contract?: string; view?: string } }) {
  const o = await dealerScope();
  if (!o) return null;
  if (!o.dealerIds.length) {
    return (
      <>
        <PageLine facts={[o.where]} />
        <Page>
          <PageHead eyebrow={o.where} title="Rentals" />
          <StoreOff title="Rentals" what="A rental fleet with a reservation calendar, meter and condition at check-out and check-in, and day, week and month billing." />
        </Page>
      </>
    );
  }
  const data = await loadRentals(o.db, o.dealerIds);
  const now = Date.now();
  const out = data.contracts.filter((c) => c.status === 'OUT');
  const late = out.filter((c) => (parseRange(c.reserved)?.end ?? Infinity) < now).length;
  const view = searchParams.view === 'contracts' || searchParams.view === 'rates' ? searchParams.view : 'board';
  return (
    <>
      <PageLine facts={[o.where, { label: `${count(out.length)} out`, strong: true }, ...(late ? [{ label: `${count(late)} late back`, strong: true }] : []), `${count(data.fleet.length)} in the fleet`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Rentals" actions={<ButtonLink variant="quiet" href="/stock?group=rental">Fleet units in Stock</ButtonLink>} />
        <RentalsView
          data={data}
          companyId={o.writeCompanyId}
          today={todayIso()}
          focusContractId={searchParams.contract && UUID.test(searchParams.contract) ? searchParams.contract : null}
          initialView={view}
        />
      </Page>
    </>
  );
}
