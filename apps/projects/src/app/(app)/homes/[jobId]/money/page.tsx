import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppLink, ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { Denied } from '@/components/dealer/common/Denied';
import { JobMoney } from '@/components/residential/JobMoney';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Job cash and margin' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Job cash position (RES-84) and the margin-fade warning (RES-122). */
export default async function JobCashAndMarginPage({ params }: { params: { jobId: string } }) {
  if (!UUID.test(params.jobId)) notFound();
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/homes');
  const job = o.jobs.byId.get(params.jobId);
  if (!job) notFound();
  const allowed = can(access, 'projects.financials', 'view', job.location_id);
  const label = o.jobs.label(params.jobId) ?? 'Job';
  return (
    <>
      <PageLine facts={[o.companyName(job.location_id) ?? o.where, { label, strong: true }, 'Job cash and margin']} />
      <Page>
        <PageHead eyebrow={<AppLink href={`/homes/${params.jobId}`}>{label}</AppLink>} title="Job cash and margin" actions={<ButtonLink variant="quiet" href={`/homes/${params.jobId}`}>The home</ButtonLink>} />
        {!allowed ? <Denied what="Job cash and margin" /> : <JobMoney jobId={params.jobId} />}
      </Page>
    </>
  );
}
