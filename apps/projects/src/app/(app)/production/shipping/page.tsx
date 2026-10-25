import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { MfgShell } from '@/components/dealer/completion/Shell';
import { jobRefs } from '@/lib/pm/ops/scope';
import { areaOpts } from '@/lib/mfg/page-data';
import { ShippingView } from '@/components/manufacturing/completion/ShopFloor';
import '@/components/ops/ops.css';

export const metadata: Metadata = { title: 'Shipping' };
export const dynamic = 'force-dynamic';

export default async function ProductionShippingPage() {
  return (
    <MfgShell guard="/production/shipping" title="Shipping" actions={<ButtonLink variant="quiet" href="/production/installs">Installs</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      const jobs = jobRefs(o, (id) => o.jobs.byId.get(id)?.location_id === companyId).filter((j) => j.open).map((j) => ({ id: j.id, label: j.label, sub: j.customer }));
      const areas = await areaOpts(o.db, jobs.map((j) => j.id));
      return <ShippingView companyId={companyId} today={today} jobs={jobs} areas={areas} />;
      }}
    </MfgShell>
  );
}
