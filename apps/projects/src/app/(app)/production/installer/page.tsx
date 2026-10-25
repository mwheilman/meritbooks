import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { MfgShell } from '@/components/dealer/completion/Shell';
import { productionOrderOpts } from '@/lib/mfg/page-data';
import { InstallerView } from '@/components/manufacturing/completion/MoneyInstall';
import '@/components/ops/ops.css';

export const metadata: Metadata = { title: 'Installer' };
export const dynamic = 'force-dynamic';

export default async function ProductionInstallerPage() {
  return (
    <MfgShell guard="/production/installer" title="Installer" actions={<ButtonLink variant="quiet" href="/production/installs">Install board</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      const orders = await productionOrderOpts(o.db, companyId);
      return <InstallerView companyId={companyId} today={today} orders={orders} />;
      }}
    </MfgShell>
  );
}
