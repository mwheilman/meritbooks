import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { MfgShell } from '@/components/dealer/completion/Shell';
import { jobRefs } from '@/lib/pm/ops/scope';
import { memberOpts, pdfDocOpts } from '@/lib/mfg/page-data';
import { EngineeringView } from '@/components/manufacturing/completion/Engineering';
import '@/components/ops/ops.css';

export const metadata: Metadata = { title: 'Engineering' };
export const dynamic = 'force-dynamic';

export default async function ProductionEngineeringPage() {
  return (
    <MfgShell guard="/production/engineering" title="Engineering" actions={<ButtonLink variant="quiet" href="/production">Production</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      const jobs = jobRefs(o, (id) => o.jobs.byId.get(id)?.location_id === companyId).filter((j) => j.open).map((j) => ({ id: j.id, label: j.label, sub: j.customer }));
      const [docs, drafters] = await Promise.all([pdfDocOpts(o.db, jobs.map((j) => j.id)), memberOpts(o.db, companyId)]);
      return <EngineeringView companyId={companyId} today={today} jobs={jobs} docs={docs} drafters={drafters} />;
      }}
    </MfgShell>
  );
}
