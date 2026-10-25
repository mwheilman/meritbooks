import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { StoreCloseView } from '@/components/dealer/completion/StoreViews';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Store close' };
export const dynamic = 'force-dynamic';

/** The day-end and month-end checklist and the sign-off. */
export default async function StockClosePage() {
  return (
    <DealerShell guard="/stock/close" title="Store close" what="The day-end and month-end checklist and the sign-off." actions={<ButtonLink variant="quiet" href="/stock/drawer">Cash drawer</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      return <StoreCloseView companyId={companyId} today={today} />;
      }}
    </DealerShell>
  );
}
