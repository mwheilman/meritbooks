import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppLink, ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { Denied } from '@/components/dealer/common/Denied';
import { DesignRooms } from '@/components/design/DesignRooms';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Rooms and FF&E' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Agreement, rooms and budgets, FF&E schedule, deposits, changes, freight claims, install day and reimbursables for one design project. */
export default async function RoomsAndFfEPage({ params }: { params: { jobId: string } }) {
  if (!UUID.test(params.jobId)) notFound();
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/design');
  const job = o.jobs.byId.get(params.jobId);
  if (!job) notFound();
  const allowed = can(access, 'projects.selections', 'view', job.location_id);
  const label = o.jobs.label(params.jobId) ?? 'Job';
  return (
    <>
      <PageLine facts={[o.companyName(job.location_id) ?? o.where, { label, strong: true }, 'Rooms and FF&E']} />
      <Page>
        <PageHead eyebrow={<AppLink href={`/design/${params.jobId}`}>{label}</AppLink>} title="Rooms and FF&E" actions={<ButtonLink variant="quiet" href={`/design/${params.jobId}`}>The project</ButtonLink>} />
        {!allowed ? <Denied what="Rooms and FF&E" /> : <DesignRooms jobId={params.jobId} companyId={job.location_id} today={todayIso()} />}
      </Page>
    </>
  );
}
