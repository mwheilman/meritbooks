import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { IncentivesView } from '@/components/dealer/completion/DealFinanceViews';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'OEM incentives' };
export const dynamic = 'force-dynamic';

/** The OEM program library and the claims each delivered deal earns, tracked to payment. */
export default async function StockIncentivesPage() {
  return (
    <DealerShell guard="/stock/incentives" title="OEM incentives" what="The OEM program library and the claims each delivered deal earns, tracked to payment." actions={<ButtonLink variant="quiet" href="/stock/programs">Programs and interfaces</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      return <IncentivesView companyId={companyId} today={today} />;
      }}
    </DealerShell>
  );
}
