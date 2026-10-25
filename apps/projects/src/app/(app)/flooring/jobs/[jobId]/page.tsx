import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { Denied } from '@/components/dealer/common/Denied';
import { FlooringJob } from '@/components/flooring/FlooringJob';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Flooring job' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Measure in, quote out, readiness, lots and cuts, and the install booking. */
export default async function FlooringJobPage({ params }: { params: { jobId: string } }) {
  if (!UUID.test(params.jobId)) notFound();
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/flooring');
  const jobCompany = o.jobs.byId.get(params.jobId)?.location_id ?? null;
  if (!jobCompany) notFound();
  const allowed = can(access, 'projects.jobs', 'view', jobCompany);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Flooring job', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Flooring job" actions={<ButtonLink variant="quiet" href="/flooring">Flooring</ButtonLink>} />
        {!allowed ? <Denied what="Flooring job" /> : <><FlooringJob jobId={params.jobId} companyId={jobCompany} today={todayIso()} /></>}
      </Page>
    </>
  );
}
