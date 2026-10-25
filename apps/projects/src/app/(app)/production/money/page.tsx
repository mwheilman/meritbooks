import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { MfgShell } from '@/components/dealer/completion/Shell';
import { jobRefs } from '@/lib/pm/ops/scope';
import { areaOpts } from '@/lib/mfg/page-data';
import { MoneyView } from '@/components/manufacturing/completion/MoneyInstall';
import '@/components/ops/ops.css';

export const metadata: Metadata = { title: 'Shop money' };
export const dynamic = 'force-dynamic';

export default async function ProductionMoneyPage() {
  return (
    <MfgShell guard="/production/money" title="Shop money" actions={<ButtonLink variant="quiet" href="/production">Production</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      const jobs = jobRefs(o, (id) => o.jobs.byId.get(id)?.location_id === companyId).filter((j) => j.open).map((j) => ({ id: j.id, label: j.label, sub: j.customer }));
      const areas = await areaOpts(o.db, jobs.map((j) => j.id));
      return <MoneyView companyId={companyId} today={today} jobs={jobs} areas={areas} />;
      }}
    </MfgShell>
  );
}
