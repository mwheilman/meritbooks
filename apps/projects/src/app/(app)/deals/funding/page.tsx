import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { DealerShell } from '@/components/dealer/completion/Shell';
import { FundingView } from '@/components/dealer/completion/DealFinanceViews';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const metadata: Metadata = { title: 'Contracts in transit' };
export const dynamic = 'force-dynamic';

/** Financed deals the lender has not funded: days out, missing stipulations, lender status, unwind. */
export default async function DealsFundingPage() {
  return (
    <DealerShell guard="/deals/funding" title="Contracts in transit" what="Financed deals the lender has not funded: days out, missing stipulations, lender status, unwind." actions={<ButtonLink variant="quiet" href="/deals">Deals</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      return <FundingView companyId={companyId} today={today} />;
      }}
    </DealerShell>
  );
}
