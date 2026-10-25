import type { Metadata } from 'next';
import { Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { can } from '@/lib/access/can';
import { jobRefs } from '@/lib/pm/ops/scope';
import { listOpenLeads, listProposals } from '@/lib/residential/queries';
import { resPage } from '@/lib/residential/page';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ProposalsList } from '@/components/residential/ProposalsList';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Proposals' };

export default async function ProposalsPage() {
  const g = await resPage('/proposals', 'projects.estimates', 'view');
  if (!g) return null;
  const { o, access, money: mv } = g;
  const [rows, leads] = await Promise.all([listProposals(o.db, o.companyIds), listOpenLeads(o.db, o.companyIds)]);
  const sent = rows.filter((r) => r.status === 'SENT');
  const companyId = o.scope.company?.id ?? null;
  const canCreate = companyId ? can(access, 'projects.estimates', 'create', companyId) : o.companyIds.some((id) => can(access, 'projects.estimates', 'create', id));
  return (
    <>
      <PageLine facts={[o.where, { label: `${count(sent.length)} out for signature`, strong: true }, ...(mv.contract && sent.length ? [{ label: `${money(sent.reduce((s, r) => s + r.total_cents, 0))} pending`, tnum: true }] : [])]} />
      <Page>
        <PageHead eyebrow={o.where} title="Proposals">
          <p className="t-cap" style={{ marginTop: 4 }}>Priced from the catalog with options and allowances, a payment schedule and the state’s cancellation notice. Accepting one builds the job: budget, schedule, selections, deposit and the homeowner’s portal.</p>
        </PageHead>
        <ProposalsList rows={rows} leads={leads} jobs={jobRefs(o)} companies={o.companies} today={todayIso()} canCreate={canCreate} />
      </Page>
    </>
  );
}
