import type { Metadata } from 'next';
import { auth } from '@clerk/nextjs/server';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { folderCounts, listFiles, listFolders, ensureFolders } from '@/lib/documents/store';
import { DOC_KINDS, type DocKind } from '@/lib/documents/types';
import { PageLine } from '@/components/common/PageLine';
import { guardPage } from '@/components/shell/page-guard';
import { DocumentsView } from '@/components/documents/DocumentsView';
import { DocsTabs } from '@/components/documents/DocsTabs';
import '@/components/ops/ops.css';
import '@/components/documents/documents.css';

export const metadata: Metadata = { title: 'Documents' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function DocumentsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/documents');
  const { userId } = await auth();
  const one = (k: string) => (typeof searchParams[k] === 'string' ? (searchParams[k] as string) : null);
  const jobs = jobRefs(o);
  const jobParam = one('job');
  const jobId = jobParam && UUID.test(jobParam) && jobs.some((j) => j.id === jobParam) ? jobParam : jobs.length === 1 ? jobs[0]!.id : null;
  const job = jobs.find((j) => j.id === jobId) ?? null;
  const folderParam = one('folder');
  const folderId = folderParam && UUID.test(folderParam) ? folderParam : null;
  const kindParam = one('kind');
  const kind = kindParam && (DOC_KINDS as readonly string[]).includes(kindParam) ? (kindParam as DocKind) : null;
  const q = (one('q') ?? '').slice(0, 120);
  const companyId = job?.companyId ?? null;
  const perms = {
    create: can(access, 'projects.documents', 'create', companyId),
    edit: can(access, 'projects.documents', 'edit', companyId),
    delete: can(access, 'projects.documents', 'delete', companyId),
  };

  let folders = jobId ? await listFolders(o.db, jobId) : [];
  if (jobId && folders.length === 0 && perms.create) {
    await ensureFolders(o.db, jobId).catch(() => 0);
    folders = await listFolders(o.db, jobId);
  }
  const [files, counts] = jobId
    ? await Promise.all([listFiles(o.db, { companyIds: o.companyIds, jobId, folderId, kind, q }), folderCounts(o.db, jobId)])
    : [[], {}];
  const signing = files.filter((f) => f.signature === 'sent').length;

  return (
    <>
      <PageLine facts={[o.where, ...(job ? [job.label] : []), ...(jobId ? [{ label: `${count(files.length)} documents`, strong: true }] : []), ...(signing ? [`${count(signing)} out for signature`] : [])]} />
      <Page>
        <PageHead eyebrow={o.where} title="Documents" />
        <DocsTabs active="files" jobId={jobId} />
        <DocumentsView jobs={jobs} jobId={jobId} folderId={folderId} kind={kind} q={q} folders={folders} counts={counts} files={files} perms={perms} readOnly={false} jobLabel={job?.label ?? ''} userId={userId ?? ''} />
      </Page>
    </>
  );
}
