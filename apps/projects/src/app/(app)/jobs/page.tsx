import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getVocabulary } from '@/lib/pm/config';
import { listJobTypes, listProjects, listStages, type ProjectSort } from '@/lib/pm/projects';
import { employeeNames } from '@/lib/pm/people';
import { lower } from '@/lib/pm/vocab';
import { cents, sumBy } from '@/lib/pm/money';
import { PageLine } from '@/components/common/PageLine';
import { JobsView } from '@/components/jobs/JobsView';

export async function generateMetadata(): Promise<Metadata> {
  const scope = await pageScope();
  if (!scope) return { title: 'Jobs' };
  const vocab = await getVocabulary(await requireDb(), scope.company?.id ?? null, scope.companyIds);
  return { title: vocab.jobs };
}

type SP = { q?: string; stage?: string; type?: string; page?: string; sort?: string; new?: string };

export default async function JobsPage({ searchParams }: { searchParams: SP }) {
  const scope = await pageScope();
  if (!scope) return null;
  const db = await requireDb();
  const sort: ProjectSort = searchParams.sort === 'number' || searchParams.sort === 'contract' ? searchParams.sort : 'updated';
  const page = Math.max(1, Number.parseInt(searchParams.page ?? '1', 10) || 1);
  const [list, any, jobTypes, stages, vocab] = await Promise.all([
    listProjects(db, { companyIds: scope.companyIds, q: searchParams.q, stage: searchParams.stage, jobTypeKey: searchParams.type, sort, page, perPage: 50 }),
    listProjects(db, { companyIds: scope.companyIds, perPage: 1 }),
    listJobTypes(db, scope.companyIds),
    listStages(db, scope.companyIds),
    getVocabulary(db, scope.company?.id ?? null, scope.companyIds),
  ]);
  const pmNames = await employeeNames(db, list.rows.map((r) => r.pm_user_id));
  const stageOptions = [...new Map(stages.map((s) => [s.stage_key, { key: s.stage_key, label: s.label }])).values()];
  const companies = scope.installedCompanies.map((c) => ({ id: c.id, name: c.name }));
  const where = scope.company?.name ?? `${count(scope.installedCompanies.length)} companies`;

  return (
    <>
      <PageLine
        facts={[
          where,
          { label: `${count(list.total)} ${lower(list.total === 1 ? vocab.job : vocab.jobs)} in this view`, strong: true },
          { label: `${cents(sumBy(list.rows, (r) => r.contract_revised_cents), 0)} revised contract on this page`, tnum: true },
        ]}
      />
      <Page>
        <PageHead eyebrow={where} title={vocab.jobs} />
        <JobsView
          rows={list.rows}
          total={list.total}
          page={list.page}
          perPage={list.perPage}
          filters={{ q: searchParams.q ?? '', stage: searchParams.stage ?? '', type: searchParams.type ?? '', sort: searchParams.sort ?? '' }}
          stages={stageOptions}
          jobTypes={jobTypes}
          companies={companies}
          defaultCompanyId={scope.company?.id ?? companies[0]?.id ?? null}
          companyNames={Object.fromEntries(scope.tenant.companies.map((c) => [c.id, c.name]))}
          pmNames={pmNames}
          multiCompany={scope.companyIds.length > 1}
          openNew={searchParams.new === '1'}
          hasAnyJobs={any.total > 0}
        />
      </Page>
    </>
  );
}
