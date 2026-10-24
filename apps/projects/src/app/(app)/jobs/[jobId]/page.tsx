import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Page, count } from '@meritbooks/merit-ui';
import { pageScope } from '@/lib/scope';
import { requireDb } from '@/lib/pm/db';
import { getJobOverview, getProject, getStageOptions } from '@/lib/pm/projects';
import { getVocabulary } from '@/lib/pm/config';
import { getBudget, listCostCodes, pickBudgets } from '@/lib/pm/budget';
import { listActivity } from '@/lib/pm/activity';
import { listChangeOrders, listContracts, listSnapshots, listTasks } from '@/lib/pm/work';
import { employeeNames } from '@/lib/pm/people';
import { jobTypeModules } from '@/lib/pm/modules';
import { jobTabs, pickTab } from '@/lib/pm/job-tabs';
import { cents, marginPctText } from '@/lib/pm/money';
import { lower } from '@/lib/pm/vocab';
import { AREAS } from '@/lib/areas';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { ActivityFeed } from '@/components/common/ActivityFeed';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { JobHeader } from '@/components/job/JobHeader';
import { JobTabsNav } from '@/components/job/JobTabsNav';
import { OverviewTab } from '@/components/job/OverviewTab';
import { BudgetTab } from '@/components/job/BudgetTab';
import { ScheduleTab } from '@/components/job/ScheduleTab';
import { ContractTab } from '@/components/job/ContractTab';
import { LaterTab } from '@/components/job/LaterTab';
import { ChangeOrderQueue } from '@/components/co/ChangeOrderQueue';
import { EstimateTab } from '@/components/money/EstimateTab';
import { listLaborRates } from '@/lib/pm/labor/queries';
import { CommitmentsTab } from '@/components/money/CommitmentsTab';
import { BillingTab } from '@/components/money/BillingTab';
import { JobCostTab } from '@/components/money/JobCostTab';
import { WorkOrdersTab } from '@/components/ops/job-tabs/WorkOrdersTab';
import { ProductionTab } from '@/components/ops/job-tabs/ProductionTab';
import { SelectionsTab } from '@/components/ops/job-tabs/SelectionsTab';
import { DrawsTab } from '@/components/ops/job-tabs/DrawsTab';
import { UnitsTab } from '@/components/ops/job-tabs/UnitsTab';
import { LogsTab } from '@/components/ops/job-tabs/LogsTab';
import { PunchTab } from '@/components/ops/job-tabs/PunchTab';
import { TimeTab } from '@/components/ops/job-tabs/TimeTab';
import { getJobBilling, getJobCommitments, getJobEstimates, getJobFinancials, getPrimaryContract, listCostCodeStatus } from '@/lib/pm/money/queries';
import { billingModesFor } from '@/lib/pm/money/billing-modes';
import { pm } from '@/lib/pm/db';
import { guardPage } from '@/components/shell/page-guard';
import { holds } from '@/lib/nav';
import type { Grant } from '@/lib/access/types';
import { moneyVisFor, seesMargin } from '@/components/money/visibility';
import { MoneyScope } from '@/components/shell/ShellContext';
import { JobTeamPanel } from '@/components/job/JobTeamPanel';
import { loadJobTeam } from '@/components/job/team-data';
import { loadJobTieout } from '@/lib/crm/tieout-server';
import { JobTieoutPanel } from '@/components/tieout/TieoutPanels';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: { jobId: string } }): Promise<Metadata> {
  if (!UUID.test(params.jobId)) return { title: 'Job' };
  const scope = await pageScope();
  if (!scope) return { title: 'Job' };
  const job = await getProject(await requireDb(), params.jobId).catch(() => null);
  return { title: job ? [job.list.job_number, job.list.name].filter(Boolean).join(' ') : 'Job' };
}

const LATER_WHAT: Record<string, string> = {
  selections: AREAS.find((a) => a.slug === 'selections')?.what ?? '',
  logs: AREAS.find((a) => a.slug === 'daily-logs')?.what ?? '',
  time: AREAS.find((a) => a.slug === 'time')?.what ?? '',
  documents: 'Drawings, contracts, photos and signed change orders, linked to the job and its records.',
};

export default async function JobPage({ params, searchParams }: { params: { jobId: string }; searchParams: { tab?: string; request?: string } }) {
  if (!UUID.test(params.jobId)) notFound();
  const scope = await pageScope();
  if (!scope) return null;
  const { access } = await guardPage('/jobs');
  const db = await requireDb();
  const job = await getProject(db, params.jobId);
  if (!job) notFound();
  const { list, project, jobType } = job;
  const modules = jobTypeModules(jobType.modules);
  const [overview, vocab, stageOpts, names, openBilling, draftCommitments] = await Promise.all([
    getJobOverview(db, list.job_id),
    getVocabulary(db, list.location_id),
    getStageOptions(db, list.location_id, jobType.stage_machine_key, project.stage_key),
    employeeNames(db, [project.pm_user_id]),
    modules.has('billing') || modules.has('retainage')
      ? pm(db).from('billing_requests').select('id', { count: 'exact', head: true }).eq('job_id', list.job_id).in('status', ['DRAFT', 'REJECTED']).then((r) => r.count ?? 0, () => 0)
      : Promise.resolve(0),
    modules.has('commitments')
      ? pm(db).from('commitments').select('id', { count: 'exact', head: true }).eq('job_id', list.job_id).eq('status', 'DRAFT').then((r) => r.count ?? 0, () => 0)
      : Promise.resolve(0),
  ]);
  // Money and module tabs follow the caller's grants AT this job's company (spec §5): absent, not greyed.
  const mv = moneyVisFor(access, list.location_id);
  const may = (g: Grant) => holds(access, g, list.location_id);
  const TAB_GRANT: Partial<Record<string, ReadonlyArray<Grant>>> = {
    estimates: ['projects.estimates:view'],
    budget: ['projects.financials:view'],
    contract: ['projects.contract_value:view'],
    'change-orders': ['projects.change_orders:view'],
    commitments: ['projects.commitments:view'],
    billing: ['projects.billing:view'],
    'job-cost': ['projects.financials:view'],
    production: ['projects.production:view'],
    selections: ['projects.selections:view'],
    draws: ['projects.billing:view'],
    time: ['projects.time:view', 'projects.time:create'],
  };
  // Money tabs also need the money their figures are made of: commitments are cost, billing and draws contract.
  const TAB_MONEY: Partial<Record<string, boolean>> = { commitments: mv.cost, billing: mv.contract, draws: mv.contract };
  const tabs = jobTabs(modules, vocab).filter((t) => {
    const need = TAB_GRANT[t.value];
    return (!need || need.some(may)) && TAB_MONEY[t.value] !== false;
  });
  const companyGrants = [...(access.byCompany[list.location_id] ?? new Set<string>())];
  const canTeam = may('projects.team:edit') && !scope.readOnly;
  const opsProps = { jobId: list.job_id, companyId: list.location_id, modules, vocabulary: vocab };
  const tab = pickTab(tabs, searchParams.tab);
  const today = todayIso();
  const multi = scope.companyIds.length > 1;
  const companyName = scope.tenant.companies.find((c) => c.id === list.location_id)?.name ?? null;
  const label = [list.job_number, list.name].filter(Boolean).join(' · ');

  let body: React.ReactNode = null;
  if (tab.later) {
    body = <LaterTab label={tab.label} what={LATER_WHAT[tab.value] ?? ''} />;
  } else if (tab.value === 'overview') {
    // Ties to Books (SHARED-RECORDS §6): for people who work the job's money, when Books is on.
    const showTie = scope.tenant.booksPresent && (mv.cost || mv.contract || may('projects.billing:view'));
    const [tasks, activity, team, tie] = await Promise.all([
      modules.has('schedule') ? listTasks(db, list.job_id) : Promise.resolve([]),
      listActivity(db, { jobId: list.job_id }, 8),
      loadJobTeam(db, list.job_id, canTeam ? { clerkUserId: scope.userId, companyId: list.location_id } : null),
      showTie ? loadJobTieout(db, access, list.job_id, list.location_id) : Promise.resolve(null),
    ]);
    body = (
      <>
      <OverviewTab
        job={list}
        overview={overview}
        tasks={tasks}
        activity={activity}
        today={today}
        hasSchedule={modules.has('schedule')}
        details={{
          jobId: list.job_id, companyId: list.location_id, customerId: list.customer_id, customerName: list.customer_name,
          plannedStart: project.planned_start, plannedFinish: project.planned_finish, actualStart: project.actual_start,
          facts: [
            { term: 'Job type', value: list.job_type_label },
            { term: 'Created', value: list.created_at.slice(0, 10) },
            ...(overview?.last_snapshot_version ? [{ term: 'Last sent to Books', value: `v${overview.last_snapshot_version} · ${overview.last_snapshot_as_of}` }] : []),
          ],
        }}
      />
      <JobTeamPanel jobId={list.job_id} team={team} canEdit={canTeam} />
      {tie && <JobTieoutPanel load={tie} jobId={list.job_id} />}
      </>
    );
  } else if (tab.value === 'budget') {
    const [bundle, codes] = await Promise.all([getBudget(db, list.job_id), listCostCodes(db, list.location_id, { jobId: list.job_id, includeInactive: true })]);
    const picked = pickBudgets(bundle.budgets);
    body = (
      <BudgetTab
        jobId={list.job_id}
        budgets={bundle.budgets}
        lines={bundle.lines}
        currentId={picked.current?.id ?? null}
        effectiveId={picked.effective?.id ?? null}
        draftId={picked.draft?.id ?? null}
        costCodes={codes}
        contractCents={list.contract_revised_cents}
        booksPresent={scope.tenant.booksPresent}
      />
    );
  } else if (tab.value === 'schedule') {
    body = <ScheduleTab jobId={list.job_id} tasks={await listTasks(db, list.job_id)} today={today} />;
  } else if (tab.value === 'change-orders') {
    const cos = await listChangeOrders(db, list.job_id);
    body = (
      <ChangeOrderQueue
        aria-label={`${vocab.change_orders} on ${label}`}
        rows={cos.map((c) => ({ ...c, jobLabel: label, company: null }))}
        showJob={false}
        createForJobId={list.job_id}
        currentUserId={scope.userId}
        mode="all"
      />
    );
  } else if (tab.value === 'contract') {
    const [contracts, snapshots] = await Promise.all([listContracts(db, list.job_id), listSnapshots(db, list.job_id)]);
    body = (
      <ContractTab
        jobId={list.job_id}
        contracts={contracts}
        snapshots={snapshots}
        originalCents={overview?.original_contract_cents ?? list.original_contract_cents}
        approvedCoCents={overview?.approved_co_cents ?? list.approved_co_cents}
        pendingCoCents={overview?.pending_co_cents ?? list.pending_co_cents}
        defaultBasis={jobType.progress_basis}
        booksPresent={scope.tenant.booksPresent}
        isSample={list.is_sample}
      />
    );
  } else if (tab.value === 'estimates') {
    const [bundle, codes, rates] = await Promise.all([
      getJobEstimates(db, list.job_id),
      listCostCodes(db, list.location_id, { jobId: list.job_id, includeInactive: true }),
      listLaborRates(db, list.location_id, { activeOnly: true }).catch(() => []),
    ]);
    body = (
      <EstimateTab
        rateCards={rates}
        jobId={list.job_id}
        estimates={bundle.estimates}
        lines={bundle.lines}
        costCodes={codes}
        contractCents={list.contract_revised_cents}
        budgetCents={list.budget_total_cents}
        booksPresent={scope.tenant.booksPresent && !list.is_sample}
      />
    );
  } else if (tab.value === 'commitments') {
    const [bundle, codes, cos, ccs] = await Promise.all([
      getJobCommitments(db, list.job_id),
      listCostCodes(db, list.location_id, { jobId: list.job_id, includeInactive: true }),
      listChangeOrders(db, list.job_id),
      listCostCodeStatus(db, list.job_id),
    ]);
    body = (
      <CommitmentsTab
        jobId={list.job_id}
        {...bundle}
        costCodes={codes}
        ownerCos={cos.filter((c) => c.stage !== 'VOID' && c.stage !== 'REJECTED').map((c) => ({ id: c.id, number: c.number, title: c.title, stage: c.stage }))}
        currentUserId={scope.userId}
        booksPresent={scope.tenant.booksPresent && !list.is_sample}
        today={today}
        budgetByCode={Object.fromEntries(ccs.filter((r) => r.cost_code_id).map((r) => [r.cost_code_id as string, r.budget_cents]))}
      />
    );
  } else if (tab.value === 'billing') {
    const [bundle, contract, codes, accepted, cos] = await Promise.all([
      getJobBilling(db, list.job_id),
      getPrimaryContract(db, list.job_id),
      listCostCodes(db, list.location_id, { jobId: list.job_id }),
      pm(db).from('estimates').select('id', { count: 'exact', head: true }).eq('job_id', list.job_id).eq('status', 'ACCEPTED').then((r) => (r.count ?? 0) > 0, () => false),
      listChangeOrders(db, list.job_id),
    ]);
    body = (
      <BillingTab
        jobId={list.job_id}
        bundle={bundle}
        modes={billingModesFor({ billingModes: jobType.billing_modes, defaultBillingMode: jobType.default_billing_mode, modules })}
        contract={contract}
        revisedContractCents={bundle.financials?.revised_contract_cents ?? list.contract_revised_cents}
        costCodes={codes}
        currentUserId={scope.userId}
        booksPresent={scope.tenant.booksPresent}
        isSample={list.is_sample}
        today={today}
        hasAcceptedEstimate={accepted}
        coStage={Object.fromEntries(cos.map((c) => [c.id, c.stage]))}
        initialRequestId={searchParams.request && UUID.test(searchParams.request) ? searchParams.request : null}
      />
    );
  } else if (tab.value === 'job-cost') {
    const [rowsCc, fin] = await Promise.all([listCostCodeStatus(db, list.job_id), getJobFinancials(db, list.job_id)]);
    body = <JobCostTab jobId={list.job_id} rows={rowsCc} financials={fin} booksPresent={scope.tenant.booksPresent && !list.is_sample} />;
  } else if (tab.value === 'work-orders') {
    body = <WorkOrdersTab {...opsProps} />;
  } else if (tab.value === 'production') {
    body = <ProductionTab {...opsProps} />;
  } else if (tab.value === 'selections') {
    body = <SelectionsTab {...opsProps} />;
  } else if (tab.value === 'draws') {
    body = <DrawsTab {...opsProps} />;
  } else if (tab.value === 'units') {
    body = <UnitsTab {...opsProps} />;
  } else if (tab.value === 'logs') {
    body = <LogsTab {...opsProps} />;
  } else if (tab.value === 'punch') {
    body = <PunchTab {...opsProps} />;
  } else if (tab.value === 'time') {
    body = <TimeTab {...opsProps} />;
  } else if (tab.value === 'activity') {
    const activity = await listActivity(db, { jobId: list.job_id }, 100);
    body = (
      <div className="mp-table">
        {activity.length ? <ActivityFeed rows={activity} showMoney={mv.contract} /> : <p className="t-cap" style={{ padding: 16 }}>Nothing has happened on this job yet.</p>}
      </div>
    );
  }

  return (
    <>
      <PageCrumbs items={[{ label: vocab.jobs, href: '/jobs' }, { label }, ...(tab.value !== 'overview' ? [{ label: tab.label }] : [])]} />
      <PageLine
        facts={[
          ...(mv.contract ? [{ label: `${cents(list.contract_revised_cents, 0)} revised contract`, tnum: true }] : []),
          ...(mv.cost ? [{ label: `${cents(list.budget_total_cents, 0)} budget`, tnum: true }] : []),
          ...(seesMargin(mv)
            ? [{ label: `${cents(overview?.projected_margin_cents ?? list.contract_revised_cents - list.cost_estimate_cents, 0)} projected margin · ${marginPctText(list)}`, strong: true, tnum: true }]
            : [{ label: list.stage_label ?? list.stage_key, strong: true }]),
          mv.contract
            ? `${count(overview?.pending_co_count ?? 0)} pending ${lower(vocab.change_orders)} · ${cents(list.pending_co_cents, 0)}`
            : `${count(overview?.pending_co_count ?? 0)} pending ${lower(vocab.change_orders)}`,
          ...(!mv.contract && overview?.tasks_overdue ? [`${count(overview.tasks_overdue)} tasks overdue`] : []),
        ]}
      />
      <Page>
        <MoneyScope grants={companyGrants}>
        <JobHeader
          jobId={list.job_id}
          companyId={list.location_id}
          number={list.job_number}
          name={list.name}
          customer={list.customer_name}
          stageLabel={list.stage_label ?? list.stage_key}
          coreStatus={list.core_status}
          pmName={project.pm_user_id ? names[project.pm_user_id] ?? null : null}
          jobTypeLabel={list.job_type_label}
          companyName={multi ? companyName : null}
          isSample={list.is_sample}
          stages={stageOpts.stages.map((s) => ({ key: s.stage_key, label: s.label, terminal: s.is_terminal }))}
          currentStage={project.stage_key}
          next={stageOpts.next.map((n) => ({ to_stage: n.to_stage, label: n.label, core_status: n.core_status, guards: n.guards }))}
        />
        <JobTabsNav
          tabs={tabs}
          value={tab.value}
          counts={{ 'change-orders': overview?.pending_co_count, schedule: overview?.tasks_overdue, billing: openBilling, commitments: draftCommitments }}
        />
        <div id="job-panel" role="tabpanel" aria-label={tab.label}>
          {body}
        </div>
        </MoneyScope>
      </Page>
    </>
  );
}
