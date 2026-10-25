import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppLink, ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { Denied } from '@/components/dealer/common/Denied';
import { Oversight } from '@/components/development/Oversight';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Project oversight' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Entitlements, status, document room, interest, fees, covenants, compliance, draws, affiliate bills, history and the Books tie-out for one SPE. */
export default async function ProjectOversightPage({ params }: { params: { jobId: string } }) {
  if (!UUID.test(params.jobId)) notFound();
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/development');
  const job = o.jobs.byId.get(params.jobId);
  if (!job) notFound();
  const allowed = can(access, 'projects.jobs', 'view', job.location_id);
  const label = o.jobs.label(params.jobId) ?? 'Job';
  return (
    <>
      <PageLine facts={[o.companyName(job.location_id) ?? o.where, { label, strong: true }, 'Project oversight']} />
      <Page>
        <PageHead eyebrow={<AppLink href={`/development/${params.jobId}`}>{label}</AppLink>} title="Project oversight" actions={<ButtonLink variant="quiet" href={`/development/${params.jobId}`}>The project</ButtonLink>} />
        {!allowed ? <Denied what="Project oversight" /> : <Oversight jobId={params.jobId} today={todayIso()} />}
      </Page>
    </>
  );
}
