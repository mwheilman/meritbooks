/**
 * SSR smoke test: every main view renders with realistic rows, and every statement
 * ties (merit-ui asserts totals in development, so a mis-tied table throws here).
 */
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MeritProvider } from '@meritbooks/merit-ui';
import { DEFAULT_VOCAB } from '@meritbooks/industry-packs';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/jobs',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { ShellProvider } from '@/components/shell/ShellContext';
import { PmHome } from '@/components/home/PmHome';
import { OwnerHome } from '@/components/home/OwnerHome';
import { JobStatement } from '@/components/insights/JobStatement';
import { BudgetTab } from '@/components/job/BudgetTab';
import { ContractTab } from '@/components/job/ContractTab';
import { ScheduleTab } from '@/components/job/ScheduleTab';
import { OverviewTab } from '@/components/job/OverviewTab';
import { JobHeader } from '@/components/job/JobHeader';
import { ChangeOrderQueue, type CoRow } from '@/components/co/ChangeOrderQueue';
import { JobsView } from '@/components/jobs/JobsView';
import { CostCodesEditor } from '@/components/settings/CostCodesEditor';
import type { HomeData } from '@/lib/pm/home';
import type { BudgetLineRow, BudgetRow, CostCodeRow, ProjectListRow, TaskRow } from '@/lib/pm/types';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function job(i: number, over: Partial<ProjectListRow> = {}): ProjectListRow {
  return {
    org_id: 'o', location_id: i % 2 ? A : B, job_id: `00000000-0000-4000-8000-00000000000${i}`, job_number: `HHC-2026-000${i}`, name: `Job ${i}`,
    core_status: i === 4 ? 'BID' : 'ACTIVE', customer_id: null, customer_name: i === 2 ? null : 'Ankeny Schools', stage_key: i === 4 ? 'lead' : 'in_progress',
    stage_label: i === 4 ? 'Lead' : 'In progress', stage_sort: i === 4 ? 0 : 2, stage_is_terminal: false, stage_entered_at: '2026-10-01T12:00:00Z',
    job_type_key: 'remodel', job_type_label: 'Remodel', archetype: 'project', pm_user_id: null, super_user_id: null, planned_start: null, planned_finish: null,
    is_sample: i === 1, original_contract_cents: 10_000_000 * i, approved_co_cents: 125_000, contract_revised_cents: 10_000_000 * i + 125_000, pending_co_cents: 50_000,
    budget_total_cents: i === 3 ? null : 8_000_000 * i, cost_estimate_cents: i === 2 ? 30_000_000 : 8_000_000 * i, created_at: '2026-09-01T12:00:00Z', updated_at: '2026-10-19T15:00:00Z',
    ...over,
  };
}
const jobs = [1, 2, 3, 4].map((i) => job(i));
const task = (id: string, due: string | null, status: TaskRow['status'] = 'TODO'): TaskRow => ({ id, job_id: jobs[0]!.job_id, title: `Task ${id}`, status, is_milestone: false, start_on: '2026-10-10', due_on: due, duration_days: 3, sort: 0, completed_at: null });
const co = (id: string, stage: CoRow['stage'], created_by = 'user_other'): CoRow => ({
  id, job_id: jobs[0]!.job_id, number: `CO-2026-000${id}`, title: 'Two recessed lights', description: null, reason: 'Owner request', stage, amount_cents: 125_000,
  cost_impact_cents: 80_000, schedule_days: 1, created_by, approved_by: null, approved_at: stage === 'APPROVED' ? '2026-10-12T12:00:00Z' : null,
  created_at: '2026-10-11T12:00:00Z', updated_at: '2026-10-11T12:00:00Z', jobLabel: 'HHC-2026-0001 · Job 1', company: 'Heartland',
});
const codes: CostCodeRow[] = [
  { id: 'c1', location_id: A, job_id: null, parent_id: null, code: '01-100', name: 'Demo labor', cost_type: 'LABOR', role_hint: null, install_id: 'i', source_pack: 'residential_remodel', sort: 0, is_active: true },
  { id: 'c2', location_id: A, job_id: null, parent_id: null, code: '06-200', name: 'Cabinets', cost_type: 'MATERIALS', role_hint: null, install_id: null, source_pack: null, sort: 1, is_active: true },
  { id: 'c3', location_id: A, job_id: null, parent_id: null, code: '09-900', name: 'Old paint', cost_type: 'MATERIALS', role_hint: null, install_id: null, source_pack: null, sort: 2, is_active: false },
];

function wrap(el: ReactElement, readOnly = false): string {
  return renderToString(
    <MeritProvider>
      <ShellProvider value={{ vocab: { ...DEFAULT_VOCAB }, companies: [], activeCompanyId: A, readOnly, setCrumbs: () => {} }}>{el}</ShellProvider>
    </MeritProvider>,
  );
}

const home: HomeData = {
  today: '2026-10-20', companyNames: { [A]: 'Heartland', [B]: 'Metro' }, multiCompany: true, projects: jobs, capped: false,
  needs: [
    { id: 'b:1', group: 'blocked', jobId: jobs[1]!.job_id, title: 'HHC-2026-0002 · Job 2', sub: 'Move to Contracted: This job has no customer on file yet.', company: 'Metro', amountCents: null, days: null, href: '/jobs/x?tab=overview', fix: 'Choose the customer' },
    { id: 't:1', group: 'overdue', jobId: jobs[0]!.job_id, title: 'Rough-in inspection', sub: 'HHC-2026-0001 · Job 1', company: 'Heartland', amountCents: null, days: 3, href: '/jobs/x?tab=schedule', fix: 'Open schedule' },
    { id: 'c:1', group: 'co', jobId: jobs[0]!.job_id, title: 'CO-2026-0001 · Lights', sub: 'Job 1 · Potential', company: 'Heartland', amountCents: 125_000, days: null, href: '/jobs/x?tab=change-orders', fix: 'Review' },
  ],
  checkedJobs: 3, openJobCount: 4,
  risk: [{ job: jobs[1]!, company: 'Metro', marginCents: -9_875_000, overdueTasks: 0, reason: 'Cost estimate over contract' }],
  week: [{ task: task('w1', '2026-10-22'), job: { job_id: jobs[0]!.job_id, job_number: 'HHC-2026-0001', name: 'Job 1' } }],
  nextDue: null, overdueCount: 1, openCos: [co('1', 'PCO')],
  activity: [{ id: 'a1', location_id: A, job_id: jobs[0]!.job_id, actor_type: 'HUMAN', actor_id: 'u', verb: 'contract.set', subject_table: 'contracts', subject_id: null, summary: 'Contract set to 4120000 cents', meta: { original_cents: 4_120_000 }, created_at: '2026-10-19T15:00:00Z' }],
};

describe('views render with real-shaped rows', () => {
  it('PM cockpit home: needs you, risk, this week, activity', () => {
    const html = wrap(<PmHome data={home} readOnly={false} />);
    expect(html).toContain('Needs you');
    expect(html).toContain('Blocked moves');
    expect(html).toContain('Set the contract to 41,200.00');
    expect(html).not.toMatch(/No data/);
  });

  it('PM cockpit home: empty and done states', () => {
    expect(wrap(<PmHome data={{ ...home, projects: [], needs: [], risk: [], week: [], activity: [], openCos: [] }} readOnly={false} />)).toContain('Create your first job');
    expect(wrap(<PmHome data={{ ...home, needs: [] }} readOnly={false} />)).toContain('Nothing needs you');
  });

  it('owner report home ties its statements (multi-company)', () => {
    const html = wrap(<OwnerHome data={home} />);
    expect(html).toContain('Jobs by stage');
    expect(html).toContain('Backlog');
    expect(html).toContain('Heartland total');
  });

  it('margin and backlog statements tie', () => {
    expect(wrap(<JobStatement rows={jobs} companyNames={home.companyNames} multi kind="margin" />)).toContain('4 jobs');
    expect(wrap(<JobStatement rows={jobs.slice(0, 1)} companyNames={home.companyNames} multi={false} kind="backlog" />)).toContain('Revised contract');
  });

  it('budget: original draft, approved, and a revision against the approved one', () => {
    const orig: BudgetRow = { id: 'b1', job_id: 'j', kind: 'ORIGINAL', version: 1, status: 'APPROVED', label: 'Original budget', as_of: '2026-10-01', created_at: '', updated_at: '' };
    const rev: BudgetRow = { ...orig, id: 'b2', kind: 'REVISED', status: 'DRAFT', label: 'Revision 1', version: 1 };
    const lines: BudgetLineRow[] = [
      { id: 'l1', budget_id: 'b1', cost_code_id: 'c1', description: null, amount_cents: 1_200_000, sort: 0 },
      { id: 'l2', budget_id: 'b1', cost_code_id: 'c2', description: 'Shaker', amount_cents: 2_400_000, sort: 1 },
      { id: 'l3', budget_id: 'b2', cost_code_id: 'c1', description: null, amount_cents: 1_500_000, sort: 0 },
      { id: 'l4', budget_id: 'b2', cost_code_id: 'c2', description: 'Shaker', amount_cents: 2_400_000, sort: 1 },
      { id: 'l5', budget_id: 'b2', cost_code_id: 'c3', description: 'Legacy code', amount_cents: 10_000, sort: 2 },
    ];
    const common = { jobId: 'j', lines, costCodes: codes, contractCents: 5_000_000, booksPresent: true };
    expect(wrap(<BudgetTab {...common} budgets={[orig]} currentId="b1" effectiveId="b1" draftId={null} />)).toContain('Revise budget');
    const revised = wrap(<BudgetTab {...common} budgets={[orig, rev]} currentId="b2" effectiveId="b1" draftId="b2" />);
    expect(revised).toContain('Save revision');
    expect(revised).toContain('Change');
    expect(wrap(<BudgetTab {...common} budgets={[]} currentId={null} effectiveId={null} draftId={null} />)).toContain('Build the original budget');
  });

  it('schedule, contract, overview and header', () => {
    const tasks = [task('1', '2026-10-15'), task('2', '2026-10-25', 'IN_PROGRESS'), task('3', null, 'DONE')];
    expect(wrap(<ScheduleTab jobId="j" tasks={tasks} today="2026-10-20" />)).toContain('Add task');
    expect(wrap(<ContractTab jobId="j" contracts={[]} snapshots={[]} originalCents={0} approvedCoCents={0} pendingCoCents={0} defaultBasis="PHYSICAL_PCT" booksPresent isSample={false} />)).toContain('Set the contract');
    const links = { contract: '/jobs/j?tab=contract', budget: '/jobs/j?tab=budget', changes: '/jobs/j?tab=change-orders', schedule: '/jobs/j?tab=schedule', activity: '/jobs/j?tab=activity' };
    const ov = wrap(
      <OverviewTab job={jobs[0]!} overview={null} tasks={tasks} activity={[]} today="2026-10-20" hasSchedule
        attention={[{ id: 'stage', tone: 'warn', title: 'Not ready for Contracted', evidence: 'This job has no customer on file yet.', action: { label: 'Choose the customer', href: '/jobs/j' } }]}
        openItems={[{ key: 'tasks', label: 'Open tasks', count: 2, href: '/jobs/j?tab=schedule' }]} photos={[]} photosHref="/documents?job=j"
        customer={null} links={links} />,
    );
    for (const t of ['Needs attention', 'Key numbers', 'Next 14 days', 'Open items', 'Latest photos', 'Recent activity', 'Choose the customer']) expect(ov).toContain(t);
    const header = wrap(
      <JobHeader jobId="j" companyId={A} number="HHC-2026-0001" name="Job 1" customer={null} site={{ label: '12 Main St', mapHref: null }} stageLabel="Lead" coreStatus="BID"
        people={[{ role: 'Project manager', name: 'Pat Lee' }]} jobTypeLabel="Remodel" companyName={null} isSample
        stages={[{ key: 'lead', label: 'Lead', terminal: false }, { key: 'won', label: 'Contracted', terminal: false }, { key: 'closed', label: 'Closed', terminal: true }]}
        currentStage="lead" next={[{ to_stage: 'won', label: 'Contracted', core_status: 'ACTIVE', guards: ['has_customer', 'has_budget'] }]}
        primary={{ kind: 'fix', label: 'Choose the customer', href: '/jobs/j', why: 'Before Contracted: no customer' }}
        figures={[{ key: 'contract', label: 'Contract', kind: 'money', value: 2_500_000, sub: 'Original', href: '/jobs/j?tab=contract' }]} booksNote={null} />,
    );
    for (const t of ['HHC-2026-0001', 'Choose the customer', 'Stage', 'Contract', '25,000', 'Pat Lee', '12 Main St', 'Sample']) expect(header).toContain(t);
  });

  it('change orders: review bands and the all view; read-only hides verbs', () => {
    const rows = [co('1', 'PCO'), co('2', 'COR', 'user_me'), co('3', 'APPROVED')];
    expect(wrap(<ChangeOrderQueue aria-label="x" rows={rows} showJob currentUserId="user_me" mode="review" />)).toContain('Requested');
    expect(wrap(<ChangeOrderQueue aria-label="x" rows={rows} showJob={false} createForJobId="j" currentUserId="user_me" mode="all" />)).toMatch(/New (<!-- -->)?change order/);
    expect(wrap(<ChangeOrderQueue aria-label="x" rows={rows} showJob currentUserId="user_me" mode="all" />, true)).not.toContain('Approve');
    expect(wrap(<ChangeOrderQueue aria-label="x" rows={[]} showJob currentUserId="u" mode="review" />)).toContain('No change orders are waiting');
  });

  it('jobs list and cost codes', () => {
    const props = { rows: jobs, total: 4, page: 1, perPage: 50, filters: { q: '', stage: '', type: '', sort: '' }, stages: [{ key: 'lead', label: 'Lead' }], jobTypes: [], companies: [{ id: A, name: 'Heartland' }], defaultCompanyId: A, companyNames: home.companyNames, pmNames: {}, multiCompany: true, openNew: false, hasAnyJobs: true };
    const html = wrap(<JobsView {...props} />);
    expect(html).toContain('HHC-2026-0001');
    expect(html).toContain('Sample');
    expect(wrap(<JobsView {...props} rows={[]} total={0} hasAnyJobs={false} />)).toContain('Create your first job');
    expect(wrap(<CostCodesEditor companyId={A} codes={codes} />)).toContain('Add cost code');
  });
});
