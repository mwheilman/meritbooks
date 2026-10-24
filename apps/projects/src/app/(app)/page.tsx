import type { Metadata } from 'next';
import { Page, PageHead, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getAccess } from '@/lib/access';
import { loadHome } from '@/lib/pm/home';
import { getModulesFor, getVocabulary } from '@/lib/pm/config';
import { lower } from '@/lib/pm/vocab';
import { shortDate } from '@meritbooks/merit-ui';
import { PageLine } from '@/components/common/PageLine';
import { HomeViewToggle } from '@/components/home/HomeViewToggle';
import { PmHome } from '@/components/home/PmHome';
import { OwnerHome } from '@/components/home/OwnerHome';
import { AdminHome } from '@/components/home/AdminHome';
import { SupervisorHome } from '@/components/home/SupervisorHome';
import { LaborToday } from '@/components/home/LaborToday';
import { loadAdminHome, loadLaborHome, loadSupervisorHome } from '@/components/home/persona-data';
import { moneyVisFor, seesMargin } from '@/components/money/visibility';
import { listAllProjects } from '@/lib/pm/projects';
import { loadCompanyTieout } from '@/lib/crm/tieout-server';
import { CompanyTieoutPanel } from '@/components/tieout/TieoutPanels';
import type { ProjectListRow } from '@/lib/pm/types';
import type { Access } from '@/lib/access/types';
import type { SupabaseClient } from '@supabase/supabase-js';

export const metadata: Metadata = { title: 'Home' };
export const dynamic = 'force-dynamic';

/**
 * Home per persona group (Wave 0a spec §5): Management the report home, PM (and Sales) the work
 * board on their own jobs, the office a needs-you queue, Supervisor and Labor a Today screen.
 * RLS already limits every row to the jobs the caller can reach.
 */
export default async function HomePage({ searchParams }: { searchParams: { view?: string } }) {
  const scope = await pageScope();
  if (!scope) return null;
  const db = await requireDb();
  const moduleIds = scope.company ? [scope.company.id] : scope.companyIds;
  const [access, vocab, modules] = await Promise.all([getAccess(), getVocabulary(db, scope.company?.id ?? null, scope.companyIds), getModulesFor(db, moduleIds, scope.installs)]);
  const where = scope.company?.name ?? (scope.view === 'consolidated' ? `${scope.tenant.orgName ?? 'Workspace'}, consolidated` : `${count(scope.installedCompanies.length)} companies`);
  const base = { db, scope, access, modules };

  if (access.group === 'labor') {
    const data = await loadLaborHome(base);
    const name = data.me ? data.me.first_name : null;
    return (
      <>
        <PageLine facts={[where, { label: data.current ? 'On a visit now' : 'Today', strong: true }, ...(data.hours.ok ? [`${(Math.round(data.hours.value.total * 100) / 100).toLocaleString('en-US')} hours this week`] : [])]} />
        <Page>
          <PageHead eyebrow={name ? `${name} · ${access.title}` : access.title} title="Today" />
          <LaborToday data={data} readOnly={scope.readOnly} />
        </Page>
      </>
    );
  }

  if (access.group === 'supervisor') {
    const data = await loadSupervisorHome(base);
    const site = data.site.ok ? data.site.value.length : 0;
    const crew = data.crewTime?.ok ? data.crewTime.value.length : 0;
    return (
      <>
        <PageLine facts={[where, shortDate(data.today), { label: `${count(site)} ${site === 1 ? 'site' : 'sites'} today`, strong: true }, ...(crew ? [`${count(crew)} time entries to approve`] : [])]} />
        <Page>
          <PageHead eyebrow={where} title="Today" />
          <div className="density-cockpit">
            <SupervisorHome data={data} readOnly={scope.readOnly} />
          </div>
        </Page>
      </>
    );
  }

  if (access.group === 'admin') {
    const [data, tie] = await Promise.all([
      loadAdminHome(base),
      scope.tenant.booksPresent ? listAllProjects(db, scope.companyIds, 1000).then((r) => companyTie(db, access, r.rows)) : Promise.resolve(null),
    ]);
    return (
      <>
        <PageLine facts={[where, { label: data.items.length ? `${count(data.items.length)} need the office` : 'Nothing waiting', strong: true }, `${count(data.openJobs)} open ${lower(vocab.jobs)}`]} />
        <Page>
          <PageHead eyebrow={where} title="Home" />
          <div className="density-cockpit">
            <AdminHome data={data} readOnly={scope.readOnly} />
            {tie}
          </div>
        </Page>
      </>
    );
  }

  // management · pm · sales: the existing homes, on the rows RLS returns
  const data = await loadHome(db, scope);
  const tie = access.group === 'management' && scope.tenant.booksPresent ? await companyTie(db, access, data.projects) : null;
  // The report home is a statement of contract, budget and margin: it needs both sides of the money.
  const management = access.group === 'management' && seesMargin(moneyVisFor(access, scope.company?.id ?? null));
  const view = management ? (searchParams.view === 'cockpit' ? 'cockpit' : 'report') : 'cockpit';
  const fact = data.needs.length
    ? { label: `${count(data.needs.length)} need you`, strong: true }
    : { label: `${count(data.openJobCount)} open ${lower(vocab.jobs)}`, strong: true };

  return (
    <>
      <PageLine facts={[where, fact, ...(data.overdueCount ? [`${count(data.overdueCount)} tasks overdue`] : [])]} />
      <Page>
        <PageHead eyebrow={management ? where : `${where} · My ${lower(vocab.jobs)}`} title="Home" actions={management ? <HomeViewToggle value={view} /> : undefined} />
        {view === 'report' ? (
          <div className="density-report">
            <OwnerHome data={data} />
            {tie}
          </div>
        ) : (
          <div className="density-cockpit">
            <PmHome data={data} readOnly={scope.readOnly} modules={modules} />
            {tie}
          </div>
        )}
      </Page>
    </>
  );
}

/** The company "Ties to Books" summary (SHARED-RECORDS §6), each row masked at its job's company. */
async function companyTie(db: SupabaseClient, access: Access, jobs: ReadonlyArray<ProjectListRow>) {
  const byJob = new Map(jobs.map((j) => [j.job_id, j.location_id]));
  const labels = Object.fromEntries(jobs.map((j) => [j.job_id, [j.job_number, j.name].filter(Boolean).join(' · ')]));
  const r = await loadCompanyTieout(db, access, byJob);
  return <CompanyTieoutPanel load={r.load} pendingDuplicates={r.pendingDuplicates} jobLabels={labels} />;
}
