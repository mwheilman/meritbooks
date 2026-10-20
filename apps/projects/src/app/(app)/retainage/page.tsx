import type { Metadata } from 'next';
import { Page, PageHead, count, money } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { scopedJobs } from '@/lib/pm/scoped';
import { listJobRetainage, listReleases } from '@/lib/pm/money/queries';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { RetainageView, type ReleaseRow, type RetainageJob } from '@/components/money/RetainageView';

export const metadata: Metadata = { title: 'Retainage' };

/** Retainage held and released by job (pm.v_job_retainage) with the release requests. */
export default async function RetainagePage() {
  const scope = await pageScope();
  if (!scope) return null;
  const db = await requireDb();
  const [jobs, ret, rel] = await Promise.all([scopedJobs(db, scope), listJobRetainage(db), listReleases(db, scope.companyIds)]);
  const multi = scope.companyIds.length > 1;
  const rows: RetainageJob[] = ret.filter((r) => jobs.byId.has(r.job_id) && (r.held_cents !== 0 || r.released_cents !== 0)).map((r) => ({
    jobId: r.job_id, jobLabel: jobs.label(r.job_id) ?? 'Job', company: jobs.company(r.job_id) ?? (multi ? 'Company' : null),
    held: r.held_cents, released: r.released_cents, outstanding: r.outstanding_cents,
  }));
  const releases: ReleaseRow[] = rel.filter((r) => jobs.byId.has(r.job_id)).map((r) => ({
    id: r.id, jobId: r.job_id, jobLabel: jobs.label(r.job_id) ?? 'Job', status: r.status, suppressed: r.suppressed_reason, amount: r.retainage_released_cents, date: r.occurred_on, invoice: r.invoice_number,
  }));
  const outstanding = rows.reduce((s, r) => s + r.outstanding, 0);
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  return (
    <>
      <PageCrumbs items={[{ label: 'Retainage' }]} />
      <PageLine facts={[where, { label: `${money(outstanding, { decimals: 0 })} outstanding`, strong: true, tnum: true }, `${count(rows.filter((r) => r.outstanding > 0).length)} jobs holding retainage`]} />
      <Page>
        <PageHead eyebrow={where} title="Retainage" />
        <RetainageView jobs={rows} releases={releases} multi={multi} booksPresent={scope.tenant.booksPresent} />
      </Page>
    </>
  );
}
