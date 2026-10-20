import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { listAllProjects } from '@/lib/pm/projects';
import { cents, marginCents, sumBy } from '@/lib/pm/money';
import { PageLine } from '@/components/common/PageLine';
import { JobStatement } from '@/components/insights/JobStatement';

const TITLES = { margin: 'Margin by job', backlog: 'Backlog' } as const;
type Report = keyof typeof TITLES;

export function generateMetadata({ params }: { params: { report: string } }): Metadata {
  return { title: TITLES[params.report as Report] ?? 'Insights' };
}

export default async function InsightPage({ params }: { params: { report: string } }) {
  if (!(params.report in TITLES)) notFound();
  const report = params.report as Report;
  const scope = await pageScope();
  if (!scope) return null;
  const db = await requireDb();
  const { rows, capped } = await listAllProjects(db, scope.companyIds, 2000);
  const open = rows.filter((r) => !r.stage_is_terminal);
  const shown = report === 'backlog' ? open.filter((r) => r.core_status === 'ACTIVE' || r.core_status === 'ON_HOLD') : open.filter((r) => r.contract_revised_cents > 0);
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;
  return (
    <>
      <PageLine
        facts={[
          where,
          { label: `${count(shown.length)} jobs`, strong: true },
          { label: `${cents(sumBy(shown, (r) => r.contract_revised_cents), 0)} revised contract`, tnum: true },
          { label: `${cents(sumBy(shown, marginCents), 0)} projected margin`, tnum: true },
          ...(capped ? ['Showing the first 2,000 jobs'] : []),
        ]}
      />
      <Page>
        <PageHead eyebrow={['Insights', where]} title={TITLES[report]} />
        <JobStatement rows={shown} companyNames={Object.fromEntries(scope.tenant.companies.map((c) => [c.id, c.name]))} multi={scope.companyIds.length > 1} kind={report} />
      </Page>
    </>
  );
}
