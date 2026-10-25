import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { MfgShell } from '@/components/dealer/completion/Shell';
import { jobRefs } from '@/lib/pm/ops/scope';
import { customerOpts } from '@/lib/dealer/page-data';
import { estimateOpts } from '@/lib/mfg/page-data';
import { BidBoardView } from '@/components/manufacturing/completion/FrontOffice';
import '@/components/ops/ops.css';

export const metadata: Metadata = { title: 'Bid board' };
export const dynamic = 'force-dynamic';

export default async function ProductionBidsPage() {
  return (
    <MfgShell guard="/production/bids" title="Bid board" actions={<><ButtonLink variant="quiet" href="/production/proposals">Proposals</ButtonLink><ButtonLink variant="quiet" href="/estimates">Estimates</ButtonLink></>}>
      {async ({ companyId, o, today }) => {
      const jobs = jobRefs(o, (id) => o.jobs.byId.get(id)?.location_id === companyId).filter((j) => j.open).map((j) => ({ id: j.id, label: j.label, sub: j.customer }));
      const [customers, estimates] = await Promise.all([customerOpts(o.db), estimateOpts(o.db, companyId, (id) => o.jobs.label(id) ?? '', ['DRAFT', 'SENT'])]);
      return <BidBoardView companyId={companyId} today={today} customers={customers} estimates={estimates} />;
      }}
    </MfgShell>
  );
}
