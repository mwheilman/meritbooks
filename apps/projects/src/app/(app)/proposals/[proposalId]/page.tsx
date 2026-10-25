import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppLink, Page, PageHead } from '@meritbooks/merit-ui';
import { HttpError } from '@/lib/api-errors';
import { can } from '@/lib/access/can';
import { loadCatalog, loadProposal } from '@/lib/residential/queries';
import { resPage, UUID } from '@/lib/residential/page';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ProposalBuilder } from '@/components/residential/ProposalBuilder';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Proposal' };

export default async function ProposalPage({ params }: { params: { proposalId: string } }) {
  if (!UUID.test(params.proposalId)) notFound();
  const g = await resPage('/proposals', 'projects.estimates', 'view');
  if (!g) return null;
  const { o, access } = g;
  let bundle;
  try {
    bundle = await loadProposal(o.db, params.proposalId);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  const p = bundle.proposal;
  const canEdit = can(access, 'projects.estimates', 'edit', p.location_id);
  const catalog = canEdit && p.status === 'DRAFT' ? await loadCatalog(o.db, p.location_id) : { items: [], assemblies: [] };
  return (
    <>
      <PageLine facts={[o.companyName(p.location_id) ?? o.where, ...(bundle.job ? [{ label: `${bundle.job.job_number} · ${bundle.job.name}`, strong: true }] : []), ...(bundle.job?.customer_name ? [bundle.job.customer_name] : [])]} />
      <Page>
        <PageHead eyebrow={<AppLink href="/proposals">Proposals</AppLink>} title={`${p.title}${p.number ? ` · ${p.number}` : ''}`} />
        <ProposalBuilder bundle={bundle} catalog={catalog} today={todayIso()} canEdit={canEdit} />
      </Page>
    </>
  );
}
