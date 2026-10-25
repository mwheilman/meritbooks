import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ButtonLink, Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope } from '@/lib/pm/ops/scope';
import { can } from '@/lib/access/can';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { Denied } from '@/components/dealer/common/Denied';
import { DevProject } from '@/components/development/DevProject';
import '@/components/ops/ops.css';
import '@/components/dealer/dealer.css';
import { guardPage } from '@/components/shell/page-guard';

export const metadata: Metadata = { title: 'Development project' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One SPE: pro forma, the lender-mapped budget, sources and the in-balance test, contingency, draws, investors. */
export default async function DevelopmentProjectPage({ params }: { params: { jobId: string } }) {
  if (!UUID.test(params.jobId)) notFound();
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/development');
  const job = o.jobs.byId.get(params.jobId);
  if (!job) notFound();
  const allowed = can(access, 'projects.financials', 'view', job.location_id);
  return (
    <>
      <PageLine facts={[o.where, { label: 'Development project', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Development project" actions={<ButtonLink variant="quiet" href="/development">Development</ButtonLink>} />
        {!allowed ? <Denied what="Development project" /> : <><DevProject jobId={params.jobId} today={todayIso()} /></>}
      </Page>
    </>
  );
}
