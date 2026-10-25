import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { sheetDetail } from '@/lib/documents/drawings';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { SheetViewer } from '@/components/documents/drawings/SheetViewer';
import '@/components/ops/ops.css';
import '@/components/documents/documents.css';

export const metadata: Metadata = { title: 'Sheet' };
export const dynamic = 'force-dynamic';

export default async function SheetPage({ params }: { params: { sheetId: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/documents');
  if (!/^[0-9a-f-]{36}$/i.test(params.sheetId)) notFound();
  const detail = await sheetDetail(o.db, params.sheetId).catch(() => null);
  if (!detail) notFound();
  const { userId } = await auth();
  const job = o.jobs.byId.get(detail.sheet.job_id);
  const company = job?.location_id ?? null;
  const label = job ? [job.job_number, job.name].filter(Boolean).join(' · ') : 'Job';
  return (
    <>
      <PageLine facts={[o.where, label, { label: detail.sheet.sheet_number, strong: true }, `${detail.revisions.length} revision${detail.revisions.length === 1 ? '' : 's'}`]} />
      <PageCrumbs items={[{ label: 'Drawings', href: `/documents/drawings?job=${detail.sheet.job_id}` }, { label: detail.sheet.sheet_number }]} />
      <Page>
        <PageHead eyebrow={[label, detail.sheet.discipline ?? 'Sheet']} title={`${detail.sheet.sheet_number}${detail.sheet.title ? ` · ${detail.sheet.title}` : ''}`} />
        <SheetViewer detail={detail} userId={userId ?? ''} canCreate={can(access, 'projects.documents', 'create', company)} canEdit={can(access, 'projects.documents', 'edit', company)} />
      </Page>
    </>
  );
}
