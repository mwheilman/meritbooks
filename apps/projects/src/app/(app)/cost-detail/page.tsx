import type { Metadata } from 'next';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadCostDetail } from '@/lib/commercial/screens';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { CostDetailView } from '@/components/commercial/CostDetailView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Job cost detail' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Job cost by code / type / period with drill to the Books source (CGC-55). Cost money: financials:view. */
export default async function CostDetailPage({ searchParams }: { searchParams: { job?: string; from?: string; to?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  await guardPage('/cost-detail');
  const jobs = jobRefs(o);
  const job = jobs.find((j) => j.id === searchParams.job) ?? null;
  const from = searchParams.from && DATE.test(searchParams.from) ? searchParams.from : null;
  const to = searchParams.to && DATE.test(searchParams.to) ? searchParams.to : null;
  const data = job ? await loadCostDetail(o.db, job.id, from, to, job.companyId) : { rows: [], codes: [], commitments: [], vendors: {} };
  return (
    <>
      <PageCrumbs items={[{ label: 'Job cost', href: '/job-cost' }, { label: job ? job.label : 'Detail' }]} />
      <PageLine facts={[o.where, { label: job ? job.label : 'Pick a job', strong: true }, ...(from || to ? [`${from ?? 'start'} to ${to ?? 'today'}`] : [])]} />
      <Page>
        <PageHead eyebrow={o.where} title="Job cost detail" />
        <CostDetailView jobId={job?.id ?? null} jobs={jobs} {...data} from={from} to={to} today={todayIso()} booksPresent={o.scope.tenant.booksPresent} />
      </Page>
    </>
  );
}
