import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { opsScope, jobRefs } from '@/lib/pm/ops/scope';
import { loadReviewPackages } from '@/lib/commercial/screens';
import { holds } from '@/lib/nav';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { guardPage } from '@/components/shell/page-guard';
import { ReviewPackageView } from '@/components/commercial/ReviewPackageView';
import '@/components/ops/ops.css';
import '@/components/commercial/commercial.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Monthly review' };

/** Month-ends, newest first (the current month, then the last 12). Pure. */
function monthEnds(today: string, n = 13): string[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - i, 0)).toISOString().slice(0, 10));
}

/** The monthly project review package, PM → PX sign-off (CGC-111). */
export default async function ProjectReviewPage({ searchParams }: { searchParams: { job?: string; period?: string } }) {
  const o = await opsScope();
  if (!o) return null;
  const { access } = await guardPage('/project-review');
  const today = todayIso();
  const periods = monthEnds(today);
  const periodEnd = searchParams.period && periods.includes(searchParams.period) ? searchParams.period : periods[1] ?? periods[0]!;
  const jobs = jobRefs(o);
  const job = jobs.find((j) => j.id === searchParams.job) ?? null;
  const packages = await loadReviewPackages(o.db, jobs.map((j) => j.id));
  const month = packages.filter((p) => p.period_end === periodEnd);
  return (
    <>
      <PageCrumbs items={[{ label: 'WIP', href: '/wip' }, { label: 'Monthly review' }, ...(job ? [{ label: job.label }] : [])]} />
      <PageLine facts={[job?.label ?? o.where, { label: `Month ending ${periodEnd}`, strong: true }, `${count(month.filter((p) => p.status === 'SIGNED').length)} of ${count(month.length)} signed off`]} />
      <Page>
        <PageHead eyebrow={o.where} title="Monthly project review" />
        <ReviewPackageView key={`${job?.id ?? 'all'}:${periodEnd}`} packages={packages} jobs={jobs} periods={periods} jobId={job?.id ?? null} periodEnd={periodEnd} today={today}
          canBuild={holds(access, 'projects.financials:edit', job?.companyId ?? o.scope.company?.id ?? null)} />
      </Page>
    </>
  );
}
