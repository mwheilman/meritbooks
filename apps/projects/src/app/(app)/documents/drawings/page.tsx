import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { listSets, listSheets } from '@/lib/documents/drawings';
import { PageLine } from '@/components/common/PageLine';
import { guardPage } from '@/components/shell/page-guard';
import { DocsTabs } from '@/components/documents/DocsTabs';
import { DrawingsView } from '@/components/documents/drawings/DrawingsView';
import '@/components/ops/ops.css';
import '@/components/documents/documents.css';

export const metadata: Metadata = { title: 'Drawings' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DrawingsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/documents');
  const jobs = jobRefs(o);
  const raw = typeof searchParams.job === 'string' ? searchParams.job : null;
  const jobId = raw && UUID.test(raw) && jobs.some((j) => j.id === raw) ? raw : jobs.length === 1 ? jobs[0]!.id : null;
  const job = jobs.find((j) => j.id === jobId) ?? null;
  const [sets, sheets] = jobId ? await Promise.all([listSets(o.db, jobId), listSheets(o.db, jobId)]) : [[], []];
  const review = sets.filter((s) => s.status === 'review').length;
  return (
    <>
      <PageLine facts={[o.where, ...(job ? [job.label] : []), ...(jobId ? [{ label: `${count(sheets.filter((s) => s.current).length)} current sheets`, strong: true }] : []), ...(review ? [`${count(review)} sets in review`] : [])]} />
      <Page>
        <PageHead eyebrow={o.where} title="Drawings" />
        <DocsTabs active="drawings" jobId={jobId} />
        <DrawingsView jobs={jobs} jobId={jobId} sets={sets} sheets={sheets} canCreate={can(access, 'projects.documents', 'create', job?.companyId ?? null)} />
      </Page>
    </>
  );
}
