import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppLink, Page, PageHead } from '@meritbooks/merit-ui';
import { HttpError } from '@/lib/api-errors';
import { can } from '@/lib/access/can';
import { resRpc } from '@/lib/residential/rpc';
import { resPage, UUID } from '@/lib/residential/page';
import type { SelectionPreview } from '@/lib/residential/types';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { SelectionChooser } from '@/components/residential/SelectionChooser';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Choose a selection' };

export default async function SelectionChoosePage({ params }: { params: { selectionId: string } }) {
  if (!UUID.test(params.selectionId)) notFound();
  const g = await resPage('/selections', 'projects.selections', 'view');
  if (!g) return null;
  const { o, access } = g;
  let preview: SelectionPreview;
  try {
    preview = await resRpc<SelectionPreview>(o.db, 'res_selection_preview', { p_selection: params.selectionId });
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 403)) notFound();
    throw e;
  }
  const job = o.jobs.byId.get(preview.job_id);
  const canApprove = !!job && can(access, 'projects.selections', 'approve', job.location_id);
  return (
    <>
      <PageLine facts={[o.where, ...(job ? [{ label: [job.job_number, job.name].filter(Boolean).join(' · '), strong: true }] : []), preview.category]} />
      <Page>
        <PageHead eyebrow={[<AppLink key="s" href={`/selections?selection=${preview.selection_id}`}>Selections</AppLink>, preview.category]} title={preview.title} />
        <SelectionChooser preview={preview} today={todayIso()} canApprove={canApprove} />
      </Page>
    </>
  );
}
