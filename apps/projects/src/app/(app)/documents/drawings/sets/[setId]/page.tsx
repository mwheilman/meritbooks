import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { setRevisions } from '@/lib/documents/drawings';
import { SET_KIND_LABEL, type DrawingSetRow } from '@/lib/documents/types';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { SetReview } from '@/components/documents/drawings/SetReview';
import '@/components/ops/ops.css';
import '@/components/documents/documents.css';

export const metadata: Metadata = { title: 'Drawing set' };
export const dynamic = 'force-dynamic';

export default async function SetPage({ params }: { params: { setId: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/documents');
  if (!/^[0-9a-f-]{36}$/i.test(params.setId)) notFound();
  const set = (await o.db.schema('pm').from('drawing_sets').select('id, job_id, name, set_kind, issued_on, source_file_id, page_count, sheet_count, status, published_at, created_at').eq('id', params.setId).maybeSingle()).data as DrawingSetRow | null;
  if (!set) notFound();
  const revisions = await setRevisions(o.db, set.id);
  const job = o.jobs.byId.get(set.job_id);
  const label = job ? [job.job_number, job.name].filter(Boolean).join(' · ') : 'Job';
  return (
    <>
      <PageLine facts={[o.where, label, { label: set.name, strong: true }, SET_KIND_LABEL[set.set_kind]]} />
      <PageCrumbs items={[{ label: 'Drawings', href: `/documents/drawings?job=${set.job_id}` }, { label: set.name }]} />
      <Page>
        <PageHead eyebrow={[label, SET_KIND_LABEL[set.set_kind]]} title={set.name} />
        <SetReview set={set} revisions={revisions} canEdit={can(access, 'projects.documents', 'edit', job?.location_id ?? null)} />
      </Page>
    </>
  );
}
