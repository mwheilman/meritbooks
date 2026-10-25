import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { customerOpts, unitOpts, vendorOpts } from '@/lib/dealer/page-data';
import { jobRefs } from '@/lib/pm/ops/scope';
import { ServiceDesk } from '@/components/dealer/completion/ServiceDesk';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Service desk' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Check-in, the appointment book, added work approved by text, QC, close and pickup. */
export default async function WorkOrdersServicePage({ searchParams }: { searchParams: { wo?: string; customer?: string } }) {
  return (
    <DealerShell guard="/work-orders/service" title="Service desk" what="Check-in, the appointment book, added work approved by text, QC, close and pickup." actions={<><ButtonLink variant="quiet" href="/work-orders/routes">Truck route</ButtonLink><ButtonLink variant="quiet" href="/work-orders/wip">Service WIP</ButtonLink><ButtonLink variant="quiet" href="/work-orders/tech-board">Tech board</ButtonLink></>}>
      {async ({ companyId, o, today }) => {
      const [customers, units, vendors] = await Promise.all([customerOpts(o.db), unitOpts(o.db, companyId), vendorOpts(o.db)]);
      const jobs = jobRefs(o, (id) => o.jobs.byId.get(id)?.location_id === companyId).filter((j) => j.open).map((j) => ({ id: j.id, label: j.label, sub: j.customer }));
      const wo = searchParams.wo && UUID.test(searchParams.wo) ? searchParams.wo : null;
      return <ServiceDesk companyId={companyId} today={today} focusWo={wo} customers={customers} units={units} jobs={jobs} vendors={vendors} />;
      }}
    </DealerShell>
  );
}
