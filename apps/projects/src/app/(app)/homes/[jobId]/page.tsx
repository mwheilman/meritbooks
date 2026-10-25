import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AppLink, Page, PageHead } from '@meritbooks/merit-ui';
import { HttpError } from '@/lib/api-errors';
import { can } from '@/lib/access/can';
import { loadHomeWorkspace } from '@/lib/residential/queries';
import { resPage, UUID } from '@/lib/residential/page';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { HomeWorkspace } from '@/components/residential/HomeWorkspace';
import '@/components/ops/ops.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Home' };

const TABS = new Set(['decisions', 'changes', 'trades', 'payments', 'home', 'site', 'closeout']);

export default async function HomeJobPage({ params, searchParams }: { params: { jobId: string }; searchParams: { tab?: string } }) {
  if (!UUID.test(params.jobId)) notFound();
  const g = await resPage('/homes', 'projects.jobs', 'view');
  if (!g) return null;
  const { o, access } = g;
  let bundle;
  try {
    bundle = await loadHomeWorkspace(o.db, params.jobId);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) notFound();
    throw e;
  }
  const job = bundle.job!;
  const c = job.location_id;
  const tab = searchParams.tab && TABS.has(searchParams.tab) ? (searchParams.tab as 'decisions') : undefined;
  return (
    <>
      <PageLine facts={[o.companyName(c) ?? o.where, { label: `${job.job_number} · ${job.name}`, strong: true }, ...(job.customer_name ? [job.customer_name] : [])]} />
      <Page>
        <PageHead eyebrow={[<AppLink key="j" href={`/jobs/${job.id}`}>{job.job_number}</AppLink>, 'Home']} title={job.name} />
        <HomeWorkspace bundle={bundle} today={todayIso()} initialTab={tab} can={{
          edit: can(access, 'projects.jobs', 'edit', c), billing: can(access, 'projects.billing', 'create', c),
          changeOrders: can(access, 'projects.change_orders', 'edit', c), selections: can(access, 'projects.selections', 'edit', c),
        }} />
      </Page>
    </>
  );
}
