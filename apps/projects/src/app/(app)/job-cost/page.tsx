import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { scopedJobs } from '@/lib/pm/scoped';
import { listJobFinancials } from '@/lib/pm/money/queries';
import { marginFade } from '@/lib/pm/money/summaries';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { JobCostView, type JobCostRow } from '@/components/money/JobCostView';

export const metadata: Metadata = { title: 'Job cost' };

/** Open jobs × contract, committed, actual and projected margin (pm.v_job_financials), worst fade first. */
export default async function JobCostPage() {
  const scope = await pageScope();
  if (!scope) return null;
  const db = await requireDb();
  const [jobs, fin] = await Promise.all([scopedJobs(db, scope), listJobFinancials(db, scope.companyIds)]);
  const rows: JobCostRow[] = fin
    .filter((f) => { const j = jobs.byId.get(f.job_id); return j && !j.stage_is_terminal && (f.revised_contract_cents > 0 || f.revised_budget_cents > 0 || f.actual_cost_cents > 0); })
    .map((f) => ({ ...f, label: jobs.label(f.job_id) ?? ([f.job_number, f.job_name].filter(Boolean).join(' · ') || 'Job'), company: jobs.company(f.job_id) }));
  const fading = rows.filter((r) => (marginFade(r) ?? 0) > 0.02).length;
  const losing = rows.filter((r) => r.projected_margin_cents < 0).length;
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  return (
    <>
      <PageCrumbs items={[{ label: 'Job cost' }]} />
      <PageLine facts={[where, { label: `${count(fading)} fading more than 2 points`, strong: fading > 0 }, ...(losing ? [{ label: `${count(losing)} projected at a loss`, strong: true }] : []), `${count(rows.length)} open jobs`]} />
      <Page>
        <PageHead eyebrow={where} title="Job cost">
          <p className="t-cap" style={{ marginTop: 4 }}>Actual cost comes from Merit Books. Open a job to refresh it and see cost by cost code.</p>
        </PageHead>
        <JobCostView rows={rows} showCompany={scope.companyIds.length > 1} />
      </Page>
    </>
  );
}
