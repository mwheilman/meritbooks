import type { Metadata } from 'next';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { cmRpc } from '@/lib/commercial/server';
import { loadProductivityJob } from '@/lib/commercial/screens';
import type { ForemanPlan } from '@/lib/commercial/screen-types';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { ForemanPlanView } from '@/components/commercial/ForemanPlanView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Daily plan' };

/** The foreman's daily plan (CGC-93). No money on this screen. */
export default async function ForemanPage({ searchParams }: { searchParams: { job?: string; date?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/foreman');
  const today = todayIso();
  const jobs = jobRefs(o).filter((j) => j.open);
  const job = jobs.find((j) => j.id === searchParams.job) ?? (jobs.length === 1 ? jobs[0]! : null);
  const date = searchParams.date && /^\d{4}-\d{2}-\d{2}$/.test(searchParams.date) ? searchParams.date : today;
  let plan: ForemanPlan | null = null;
  let error: string | null = null;
  let extra = { codes: [] as Awaited<ReturnType<typeof loadProductivityJob>>['codes'], units: [] as Awaited<ReturnType<typeof loadProductivityJob>>['units'] };
  if (job) {
    try {
      const [p, x] = await Promise.all([cmRpc<ForemanPlan>(o.db, 'cm_foreman_plan', { p_job: job.id, p_date: date }), loadProductivityJob(o.db, job.id, job.companyId)]);
      plan = p;
      extra = { codes: x.codes, units: x.units };
    } catch (e) {
      error = e instanceof Error ? e.message : 'The plan did not load.';
    }
  }
  return (
    <>
      <PageCrumbs items={[{ label: 'Daily plan' }]} />
      <PageLine facts={[job ? job.label : o.where, { label: date === today ? 'Today' : date, strong: true }, ...(plan ? [`${plan.crew.length} crew`, `${plan.tasks.length} tasks`] : [])]} />
      <Page>
        <PageHead eyebrow={job?.label ?? o.where} title="Daily plan" />
        <ForemanPlanView jobs={jobs} jobId={job?.id ?? null} date={date} plan={plan} {...extra} today={today} error={error} canLog={holds(access, 'projects.time:create', job?.companyId ?? null)} />
      </Page>
    </>
  );
}
