import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppLink, ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { Denied } from '@/components/dealer/common/Denied';
import { SiteCapture } from '@/components/residential/SiteCapture';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Site capture' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** In-home measure and site capture (RES-11). */
export default async function SiteCapturePage({ params }: { params: { jobId: string } }) {
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
      <PageLine facts={[o.companyName(job.location_id) ?? o.where, { label, strong: true }, 'Site capture']} />
      <Page>
        <PageHead eyebrow={<AppLink href={`/homes/${params.jobId}`}>{label}</AppLink>} title="Site capture" actions={<ButtonLink variant="quiet" href={`/homes/${params.jobId}`}>The home</ButtonLink>} />
        {!allowed ? <Denied what="Site capture" /> : <SiteCapture jobId={params.jobId} today={todayIso()} />}
      </Page>
    </>
  );
}
