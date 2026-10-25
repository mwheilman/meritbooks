import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { MfgShell } from '@/components/dealer/completion/Shell';
import { jobRefs } from '@/lib/pm/ops/scope';
import { stockLocationOpts, vendorOpts } from '@/lib/dealer/page-data';
import { operationOpts, productionOrderOpts } from '@/lib/mfg/page-data';
import { ShopFloorView } from '@/components/manufacturing/completion/ShopFloor';
import '@/components/ops/ops.css';

export const metadata: Metadata = { title: 'Shop floor' };
export const dynamic = 'force-dynamic';

export default async function ProductionShopPage() {
  return (
    <MfgShell guard="/production/shop" title="Shop floor" actions={<ButtonLink variant="quiet" href="/production/materials">Material</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      const jobs = jobRefs(o, (id) => o.jobs.byId.get(id)?.location_id === companyId).filter((j) => j.open).map((j) => ({ id: j.id, label: j.label, sub: j.customer }));
      const [sl, orders, vendors] = await Promise.all([stockLocationOpts(o.db, [companyId]), productionOrderOpts(o.db, companyId), vendorOpts(o.db)]);
      const label = new Map(orders.map((x) => [x.id, x.label.split(' · ')[0] ?? '']));
      const operations = await operationOpts(o.db, orders.map((x) => x.id), (id) => label.get(id) ?? '');
      return <ShopFloorView companyId={companyId} today={today} stockLocations={sl.map((s) => ({ id: s.id, label: `${s.code} · ${s.name}` }))} orders={orders} jobs={jobs} vendors={vendors} operations={operations} />;
      }}
    </MfgShell>
  );
}
