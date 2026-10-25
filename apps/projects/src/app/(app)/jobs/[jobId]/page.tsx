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
import { pickJobTab, resolveJobTabs, type JobTabValue } from '@/lib/pm/job-tabs';
import { checkGuards } from '@/lib/pm/projects';
import { lower } from '@/lib/pm/vocab';
import { todayIso } from '@/lib/time';
import { PageLine } from '@/components/common/PageLine';
import { PageCrumbs } from '@/components/shell/ShellContext';
import { JobHeader, type PrimaryAction } from '@/components/job/JobHeader';
import { JobTabsNav } from '@/components/job/JobTabsNav';
import { OverviewTab, type OpenItem } from '@/components/job/OverviewTab';
import { JobRail } from '@/components/job/JobRail';
import { JobDocumentsPanel } from '@/components/job/JobDocumentsPanel';
import { JobActivity } from '@/components/job/JobActivity';
import { headerFigures } from '@/components/job/header-figures';
import { jobAttention } from '@/components/job/job-attention';
import { LATER_TABS } from '@/components/job/later-tabs';
import { loadCustomerContacts, loadJobPhotos, loadJobSite, loadOpenCounts } from '@/components/job/overview-data';
import { getCompanyExperience } from '@/lib/packs/experience-server';
import { scheduleViewFor } from '@/lib/packs/experience';
import { jobViewFromPack } from '@/lib/pm/schedule/views';
import { aiConfigured } from '@/lib/ai/gateway';
import { guardCopy, guardFixHref } from '@/lib/pm/guards';
import { BudgetTab } from '@/components/job/BudgetTab';
import { Gantt } from '@/components/schedule/Gantt';
import { loadJobSchedule } from '@/lib/pm/schedule/server';
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
import type { JobDetailsProps } from '@/components/job/JobDetails';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: { jobId: string } }): Promise<Metadata> {
  if (!UUID.test(params.jobId)) return { title: 'Job' };
  const scope = await pageScope();
  if (!scope) return { title: 'Job' };
  const job = await getProject(await requireDb(), params.jobId).catch(() => null);
  return { title: job ? [job.list.job_number, job.list.name].filter(Boolean).join(' ') : 'Job' };
}

/** AI on the job page: there is no per-job Ask yet, so the box says so and shows the rule checks. */
function jobAi(): { available: boolean; reason: string } {
  return aiConfigured()
    ? { available: false, reason: 'Questions and suggestions about this job arrive with the Ask release. The checks below still run.' }
    : { available: false, reason: 'The AI service is not switched on for this workspace. The checks below still run.' };
}

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
  // Money and module tabs follow the caller's grants AT this job's company (spec §5): absent, not greyed.
  const mv = moneyVisFor(access, list.location_id);
  const may = (g: Grant) => holds(access, g, list.location_id);
  const [overview, vocab, stageOpts, names, open, experience, site] = await Promise.all([
    getJobOverview(db, list.job_id),
    getVocabulary(db, list.location_id),
    getStageOptions(db, list.location_id, jobType.stage_machine_key, project.stage_key),
    employeeNames(db, [project.pm_user_id, list.super_user_id]),
    loadOpenCounts(db, list.job_id, modules),
    getCompanyExperience(db, list.location_id),
    loadJobSite(db, list.job_id),
  ]);
  const fin = mv.cost || mv.contract ? await getJobFinancials(db, list.job_id).catch(() => null) : null;

  // ---- tabs: the pack's set for this job type (manifest v2), filtered by grants and money
  const TAB_GRANT: Partial<Record<JobTabValue, ReadonlyArray<Grant>>> = {
    estimates: ['projects.estimates:view'],
    budget: ['projects.financials:view'],
    contract: ['projects.contract_value:view'],
    'change-orders': ['projects.change_orders:view'],
    commitments: ['projects.commitments:view'],
    billing: ['projects.billing:view'],
    'job-cost': ['projects.financials:view'],
    production: ['projects.production:view'],
    bom: ['projects.production:view'],
    selections: ['projects.selections:view'],
    draws: ['projects.billing:view'],
    'capital-stack': ['projects.billing:view'],
    time: ['projects.time:view', 'projects.time:create'],
    'work-orders': ['projects.jobs:view'],
    documents: ['projects.documents:view'],
    parts: ['projects.store:view'],
    'warranty-claim': ['projects.store:view'],
    receiving: ['projects.commitments:view'],
    productivity: ['projects.financials:view'],
  };
  // Money tabs also need the money their figures are made of: commitments are cost, billing and draws contract.
  const TAB_MONEY: Partial<Record<JobTabValue, boolean>> = {
    commitments: mv.cost, receiving: mv.cost, billing: mv.contract, draws: mv.contract, 'capital-stack': mv.contract, productivity: mv.cost,
  };
  const resolved = resolveJobTabs({
    experience: experience?.experience,
    jobTypeKey: jobType.key,
    modules,
    vocab,
    allow: (t) => {
      const need = TAB_GRANT[t];
      return (!need || need.some(may)) && TAB_MONEY[t] !== false;
    },
  });
  const tab = pickJobTab(resolved, searchParams.tab);
  const allTabs = new Set<string>([...resolved.visible, ...resolved.more].map((t) => t.value));
  const hasTab = (t: string) => allTabs.has(t);
  const base = `/jobs/${list.job_id}`;
  const tabHref = (t: JobTabValue) => (t === resolved.defaultTab ? base : hasTab(t) ? `${base}?tab=${t}` : base);

  const companyGrants = [...(access.byCompany[list.location_id] ?? new Set<string>())];
  const canTeam = may('projects.team:edit') && !scope.readOnly;
  const opsProps = { jobId: list.job_id, companyId: list.location_id, modules, vocabulary: vocab };
  const today = todayIso();
  const multi = scope.companyIds.length > 1;
  const companyName = scope.tenant.companies.find((c) => c.id === list.location_id)?.name ?? null;
  const label = [list.job_number, list.name].filter(Boolean).join(' · ');

  // ---- the next forward stage, what blocks it, and the one primary action
  const sortOf = new Map(stageOpts.stages.map((st) => [st.stage_key, st]));
  const curSort = sortOf.get(project.stage_key)?.sort ?? 0;
  const forward = stageOpts.next
    .filter((n) => (sortOf.get(n.to_stage)?.sort ?? 0) > curSort && n.core_status !== 'CANCELLED')
    .sort((a, b) => (sortOf.get(a.to_stage)?.sort ?? 0) - (sortOf.get(b.to_stage)?.sort ?? 0))[0];
  const failing = forward ? await checkGuards(db, list.job_id, forward.guards) : [];
  const primary: PrimaryAction = !forward
    ? null
    : failing.length
      ? { kind: 'fix', label: guardCopy(failing[0]!).fix.label, href: guardFixHref(failing[0]!, list.job_id), why: `Before ${forward.label}: ${guardCopy(failing[0]!).failing}` }
      : may('projects.jobs:edit') ? { kind: 'move', to: forward.to_stage, label: `Move to ${forward.label}` } : null;

  const contract = overview?.revised_contract_cents ?? list.contract_revised_cents;
  const costEstimate = fin?.projected_final_cost_cents ?? overview?.cost_estimate_cents ?? list.cost_estimate_cents;
  const projectedMargin = fin?.projected_margin_cents ?? overview?.projected_margin_cents ?? contract - costEstimate;
  const attention = jobAttention({
    jobId: list.job_id,
    nextStage: forward ? { label: forward.label, failing } : null,
    pendingCoCount: overview?.pending_co_count ?? 0,
    overdueTasks: overview?.tasks_overdue ?? 0,
    hasBudgetModule: modules.has('budget') && mv.cost,
    hasBudget: list.budget_total_cents != null,
    draftBilling: open.draftBilling ?? 0,
    draftCommitments: mv.cost ? open.draftCommitments ?? 0 : 0,
    punchOpen: overview?.punch_open ?? 0,
    overContract: seesMargin(mv) && contract > 0 ? costEstimate > contract : null,
    vocab,
    hasTab,
  });

  const figures = headerFigures({
    revisedContractCents: contract,
    originalContractCents: overview?.original_contract_cents ?? list.original_contract_cents,
    billedCents: fin?.billed_to_date_cents ?? null,
    costToDateCents: fin?.actual_cost_cents ?? null,
    projectedCostCents: costEstimate,
    committedCents: fin?.committed_cents ?? null,
    budgetCents: list.budget_total_cents,
    projectedMarginCents: projectedMargin,
    pendingCoCents: overview?.pending_co_cents ?? list.pending_co_cents,
    pendingCoCount: overview?.pending_co_count ?? 0,
    openTasks: overview?.tasks_open ?? 0,
    overdueTasks: overview?.tasks_overdue ?? 0,
    punchOpen: overview?.punch_open ?? 0,
    stageLabel: list.stage_label ?? list.stage_key,
  }, mv, base, hasTab);

  const people = [
    ...(project.pm_user_id && names[project.pm_user_id] ? [{ role: vocab.pm, name: names[project.pm_user_id]! }] : []),
    ...(list.super_user_id && names[list.super_user_id] ? [{ role: vocab.superintendent, name: names[list.super_user_id]! }] : []),
  ];
  const customer = list.customer_name ? { id: list.customer_id, name: list.customer_name } : null;

  const details: JobDetailsProps = {
    jobId: list.job_id, companyId: list.location_id, customerId: list.customer_id, customerName: list.customer_name,
    plannedStart: project.planned_start, plannedFinish: project.planned_finish, actualStart: project.actual_start,
    facts: [
      { term: 'Job type', value: list.job_type_label },
      { term: 'Created', value: list.created_at.slice(0, 10) },
      ...(overview?.last_snapshot_version ? [{ term: 'Last sent to Books', value: `v${overview.last_snapshot_version} · ${overview.last_snapshot_as_of}` }] : []),
    ],
  };
  const [team, contacts] = await Promise.all([
    loadJobTeam(db, list.job_id, canTeam && tab.value === 'team' ? { clerkUserId: scope.userId, companyId: list.location_id } : null),
    loadCustomerContacts(db, list.customer_id),
  ]);

  let body: React.ReactNode = null;
  if (tab.later) {
    const copy = LATER_TABS[tab.value];
    body = <LaterTab label={tab.label} what={copy?.what ?? ''} meanwhile={copy?.meanwhile ? { label: copy.meanwhile.label, href: copy.meanwhile.href(list.job_id) } : undefined} />;
  } else if (tab.value === 'overview') {
    // Ties to Books (SHARED-RECORDS §6): for people who work the job's money, when Books is on.
    const showTie = scope.tenant.booksPresent && (mv.cost || mv.contract || may('projects.billing:view'));
    const [tasks, activity, photos, tie] = await Promise.all([
      modules.has('schedule') ? listTasks(db, list.job_id) : Promise.resolve([]),
      listActivity(db, { jobId: list.job_id }, 40),
      loadJobPhotos(db, list.job_id),
      showTie ? loadJobTieout(db, access, list.job_id, list.location_id) : Promise.resolve(null),
    ]);
    const openItems: OpenItem[] = [
      { key: 'tasks', label: 'Open tasks', count: overview?.tasks_open ?? 0, href: tabHref('schedule') },
      { key: 'cos', label: `Pending ${lower(vocab.change_orders)}`, count: overview?.pending_co_count ?? 0, href: tabHref('change-orders') },
      ...(open.workOrders != null ? [{ key: 'wo', label: `Open ${lower(vocab.work_orders)}`, count: open.workOrders, href: tabHref('work-orders') }] : []),
      ...(open.selections != null && hasTab('selections') ? [{ key: 'sel', label: `${vocab.selections} waiting`, count: open.selections, href: tabHref('selections') }] : []),
      ...(open.draftBilling != null && hasTab('billing') ? [{ key: 'bill', label: `${vocab.billing} drafts`, count: open.draftBilling, href: tabHref('billing') }] : []),
      ...(open.draftCommitments != null && hasTab('commitments') ? [{ key: 'po', label: `Draft ${lower(vocab.commitments)}`, count: open.draftCommitments, href: tabHref('commitments') }] : []),
      ...(modules.has('punch_warranty') ? [{ key: 'punch', label: 'Open punch items', count: overview?.punch_open ?? 0, href: tabHref('punch') }] : []),
    ].filter((x) => x.count > 0);
    const primaryContact = contacts?.find((c) => c.primary) ?? contacts?.[0] ?? null;
    body = (
      <>
        <OverviewTab
          job={list}
          overview={overview}
          tasks={tasks}
          activity={activity}
          today={today}
          hasSchedule={modules.has('schedule')}
          attention={attention}
          openItems={openItems}
          photos={photos}
          photosHref={`/documents?job=${list.job_id}`}
          customer={customer ? { ...customer, primaryContact: primaryContact ? primaryContact.name : null } : null}
          links={{ contract: tabHref('contract'), budget: tabHref('budget'), changes: tabHref('change-orders'), schedule: tabHref('schedule'), activity: tabHref('activity') }}
        />
        {tie && <JobTieoutPanel load={tie} jobId={list.job_id} />}
      </>
    );
  } else if (tab.value === 'documents') {
    body = <JobDocumentsPanel jobId={list.job_id} canDrawings={may('projects.documents:view')} />;
  } else if (tab.value === 'team') {
    body = <JobTeamPanel jobId={list.job_id} team={team} canEdit={canTeam} />;
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
    // Gantt (WAVE1-SCHEDULE-SPEC): edits need projects.jobs:edit at this job's company; Labor and
    // view-only seats get the same schedule read-only. Billing amounts need contract_value.
    const bundle = await loadJobSchedule(db, { jobId: list.job_id, companyId: list.location_id, plannedStart: project.planned_start });
    body = (
      <Gantt
        bundle={bundle}
        jobLabel={label}
        today={today}
        userId={scope.userId}
        canEdit={may('projects.jobs:edit') && !scope.readOnly}
        showBilling={mv.contract}
        archetype={jobType.archetype}
        jobTypeKey={jobType.key}
        jobTypeLabel={jobType.label}
        defaultView={jobViewFromPack(scheduleViewFor(experience?.experience, jobType.key), jobType.archetype)}
      />
    );
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
    const activity = await listActivity(db, { jobId: list.job_id }, 200);
    body = (
      <div className="mp-table">
        <JobActivity rows={activity} showMoney={mv.contract} />
      </div>
    );
  }

  const counts: Partial<Record<JobTabValue, number>> = {
    'change-orders': overview?.pending_co_count,
    schedule: overview?.tasks_overdue,
    billing: open.draftBilling ?? undefined,
    commitments: open.draftCommitments ?? undefined,
    'work-orders': open.workOrders ?? undefined,
    selections: open.selections ?? undefined,
    punch: overview?.punch_open,
    overview: attention.length || undefined,
  };

  return (
    <>
      <PageCrumbs items={[{ label: vocab.jobs, href: '/jobs' }, { label, href: base }, ...(tab.value !== resolved.defaultTab ? [{ label: tab.label }] : [])]} />
      <PageLine
        facts={[
          { label: list.stage_label ?? list.stage_key, strong: true },
          list.job_type_label,
          ...(overview?.tasks_overdue ? [`${count(overview.tasks_overdue)} tasks overdue`] : []),
          ...(overview?.pending_co_count ? [`${count(overview.pending_co_count)} pending ${lower(vocab.change_orders)}`] : []),
        ]}
      />
      <Page>
        <MoneyScope grants={companyGrants}>
          <JobHeader
            jobId={list.job_id}
            companyId={list.location_id}
            number={list.job_number}
            name={list.name}
            customer={customer}
            site={site}
            stageLabel={list.stage_label ?? list.stage_key}
            coreStatus={list.core_status}
            people={people}
            jobTypeLabel={list.job_type_label}
            companyName={multi ? companyName : null}
            isSample={list.is_sample}
            stages={stageOpts.stages.map((st) => ({ key: st.stage_key, label: st.label, terminal: st.is_terminal }))}
            currentStage={project.stage_key}
            next={stageOpts.next.map((n) => ({ to_stage: n.to_stage, label: n.label, core_status: n.core_status, guards: n.guards }))}
            primary={primary}
            figures={figures}
            booksNote={scope.tenant.booksPresent && fin ? 'Billed and cost as Merit Books has them' : null}
          />
          <div className="job-layout">
            <div className="job-main">
              <JobTabsNav visible={resolved.visible} more={resolved.more} value={tab.value} defaultTab={resolved.defaultTab} counts={counts} />
              <div id="job-panel" role="tabpanel" aria-label={tab.label}>
                {body}
              </div>
            </div>
            <JobRail
              jobId={list.job_id}
              details={details}
              customer={customer}
              contacts={contacts}
              team={{ members: team.members, error: team.error }}
              ai={jobAi()}
              attention={attention}
            />
          </div>
        </MoneyScope>
      </Page>
    </>
  );
}
