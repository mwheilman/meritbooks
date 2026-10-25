import type { Metadata } from 'next';
import { ButtonLink } from '@meritbooks/merit-ui';
import { MfgShell } from '@/components/dealer/completion/Shell';
import { estimateOpts } from '@/lib/mfg/page-data';
import { ProposalsView } from '@/components/manufacturing/completion/FrontOffice';
import '@/components/ops/ops.css';

export const metadata: Metadata = { title: 'Proposals' };
export const dynamic = 'force-dynamic';

export default async function ProductionProposalsPage() {
  return (
    <MfgShell guard="/production/proposals" title="Proposals" actions={<ButtonLink variant="quiet" href="/production/bids">Bid board</ButtonLink>}>
      {async ({ companyId, o, today }) => {
      const estimates = await estimateOpts(o.db, companyId, (id) => o.jobs.label(id) ?? '');
      return <ProposalsView estimates={estimates} today={today} />;
      }}
    </MfgShell>
  );
}
