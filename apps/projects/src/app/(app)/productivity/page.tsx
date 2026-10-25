import type { Metadata } from 'next';
import { Page, PageHead } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { ProductivityPicker } from '@/components/commercial/ProductivityPicker';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Productivity' };

/** Installed quantities, earned vs actual hours and fade alerts by job (CGC-89, CGC-90). Hours only. */
export default async function ProductivityPage({ searchParams }: { searchParams: { job?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/productivity');
  const jobs = jobRefs(o).filter((j) => j.open);
  const job = jobs.find((j) => j.id === searchParams.job) ?? (jobs.length === 1 ? jobs[0]! : null);
  const company = job?.companyId ?? o.scope.company?.id ?? null;
  return (
    <>
      <PageCrumbs items={[{ label: 'Productivity' }]} />
      <PageLine facts={[o.where, { label: job ? job.label : 'Pick a job', strong: true }]} />
      <Page>
        <PageHead eyebrow={o.where} title="Labor productivity" />
        <ProductivityPicker jobs={jobs} jobId={job?.id ?? null} today={todayIso()}
          canLog={holds(access, 'projects.time:create', company)} canSetUnits={holds(access, 'projects.jobs:edit', company)} canFade={holds(access, 'projects.time:approve', company)} />
      </Page>
    </>
  );
}
