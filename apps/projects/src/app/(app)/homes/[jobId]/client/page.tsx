import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppLink, ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { Denied } from '@/components/dealer/common/Denied';
import { ClientSide } from '@/components/residential/ClientSide';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Homeowner updates' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the homeowner sees: schedule changes to explain (RES-52), the weekly update (RES-90) and the closeout package (RES-97). */
export default async function HomeownerUpdatesPage({ params }: { params: { jobId: string } }) {
  if (!UUID.test(params.jobId)) notFound();
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/homes');
  const job = o.jobs.byId.get(params.jobId);
  if (!job) notFound();
  const allowed = can(access, 'projects.jobs', 'view', job.location_id);
  const label = o.jobs.label(params.jobId) ?? 'Job';
  return (
    <>
      <PageLine facts={[o.companyName(job.location_id) ?? o.where, { label, strong: true }, 'Homeowner updates']} />
      <Page>
        <PageHead eyebrow={<AppLink href={`/homes/${params.jobId}`}>{label}</AppLink>} title="Homeowner updates" actions={<ButtonLink variant="quiet" href={`/homes/${params.jobId}`}>The home</ButtonLink>} />
        {!allowed ? <Denied what="Homeowner updates" /> : <ClientSide jobId={params.jobId} today={todayIso()} />}
      </Page>
    </>
  );
}
