import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppLink, Page, PageHead } from '@meritbooks/merit-ui';
import { HttpError } from '@/lib/api-errors';
import { can } from '@/lib/access/can';
import { loadCatalog, loadProposal } from '@/lib/residential/queries';
import { resPage, UUID } from '@/lib/residential/page';
import { PageLine } from '@/components/common/PageLine';
import { Denied } from '@/components/dealer/common/Denied';
import { KbImport } from '@/components/residential/KbImport';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Import a cabinet list' };

/** K&B design-software import (RES-23) onto a draft proposal. */
export default async function ProposalImportPage({ params }: { params: { proposalId: string } }) {
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
  const catalog = canEdit && p.status === 'DRAFT' ? (await loadCatalog(o.db, p.location_id)).items.map((i) => ({ id: i.id, code: i.code, name: i.name })) : [];
  return (
    <>
      <PageLine facts={[o.companyName(p.location_id) ?? o.where, { label: `${p.title}${p.number ? ` · ${p.number}` : ''}`, strong: true }, 'Cabinet list import']} />
      <Page>
        <PageHead eyebrow={<AppLink href={`/proposals/${p.id}`}>{p.title}</AppLink>} title="Import a cabinet list" />
        {!canEdit ? <Denied what="Proposal import" /> : <KbImport proposalId={p.id} catalog={catalog} draft={p.status === 'DRAFT'} />}
      </Page>
    </>
  );
}
