import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { MfgShell } from '@/components/dealer/completion/Shell';
import { jobRefs } from '@/lib/pm/ops/scope';
import { areaOpts, estimateOpts, productOpts } from '@/lib/mfg/page-data';
import { TakeoffView } from '@/components/manufacturing/completion/TakeoffView';
import '@/components/ops/ops.css';

export const metadata: Metadata = { title: 'Drawing takeoff' };
export const dynamic = 'force-dynamic';

export default async function ProductionTakeoffPage() {
  return (
    <MfgShell guard="/production/takeoff" title="Drawing takeoff" actions={<ButtonLink variant="quiet" href="/production/products">Product library</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      const jobs = jobRefs(o, (id) => o.jobs.byId.get(id)?.location_id === companyId).filter((j) => j.open).map((j) => ({ id: j.id, label: j.label, sub: j.customer }));
      const ids = jobs.map((j) => j.id);
      const [areas, products, estimates] = await Promise.all([areaOpts(o.db, ids), productOpts(o.db, companyId), estimateOpts(o.db, companyId, (id) => o.jobs.label(id) ?? '', ['DRAFT'])]);
      return <TakeoffView jobs={jobs} areas={areas} products={products} estimates={estimates} />;
      }}
    </MfgShell>
  );
}
