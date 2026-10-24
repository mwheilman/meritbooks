/**
 * Schedule UI: permissions (edit vs Labor / view-only, engine off, billing masked), the empty
 * state's template action, the global page's three views, and the 2,000-task render budget.
 */
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MeritProvider } from '@meritbooks/merit-ui';
import { DEFAULT_VOCAB } from '@meritbooks/industry-packs';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/jobs/j',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { ShellProvider } from '@/components/shell/ShellContext';
import { Gantt, type GanttProps } from '@/components/schedule/Gantt';
import { TaskPanel } from '@/components/schedule/TaskPanel';
import { GlobalSchedule } from '@/components/schedule/GlobalSchedule';
import { buildOutline } from '@/lib/pm/schedule/tree';
import { DEFAULT_CALENDAR, type JobScheduleBundle, type SchedDep, type SchedTask } from '@/lib/pm/schedule/types';
import type { Vocabulary } from '@/lib/pm/vocab';

const J = '00000000-0000-4000-8000-000000000001';
const TODAY = '2026-10-26';

function wrap(el: ReactElement): string {
  return renderToString(
    <MeritProvider>
      <ShellProvider value={{ vocab: { ...DEFAULT_VOCAB } as Vocabulary, companies: [], activeCompanyId: null, readOnly: false, setCrumbs: () => {} }}>{el}</ShellProvider>
    </MeritProvider>,
  );
}

const task = (i: number, over: Partial<SchedTask> = {}): SchedTask => ({
  id: `t${i}`, job_id: J, parent_task_id: null, title: `Task ${i}`, status: 'TODO', is_milestone: false, is_summary: false, sort: i, wbs_code: null,
  duration_days: 2, start_on: '2026-11-02', due_on: '2026-11-03', pct_complete: null, constraint_type: 'ASAP', constraint_date: null,
  actual_start: null, actual_finish: null, early_start: null, early_finish: null, late_start: null, late_finish: null, total_float: 0, free_float: 0,
  is_critical: true, constraint_conflict: false, assignee_employee_id: null, assigned_crew_id: null, assigned_vendor_id: null, commitment_id: null,
  hours_per_day: null, template_ref: null, cpm_at: '2026-10-26T12:00:00Z', billing_amount_cents: null, ...over,
});

const bundle = (tasks: SchedTask[], deps: SchedDep[] = [], over: Partial<JobScheduleBundle> = {}): JobScheduleBundle => ({
  jobId: J, engine: true, tasks, deps, calendar: DEFAULT_CALENDAR, header: null, baseline: null, baselineTasks: [], crews: [{ id: 'c1', name: 'Framing crew', capacity_hours: 8 }],
  templates: [], plannedStart: null, ...over,
});

const props = (b: JobScheduleBundle, over: Partial<GanttProps> = {}): GanttProps => ({
  bundle: b, jobLabel: '1042 · Smith kitchen', today: TODAY, userId: 'u1', canEdit: true, showBilling: false, archetype: 'project', jobTypeKey: 'kitchen_remodel', jobTypeLabel: 'Kitchen remodel', ...over,
});

const three = [task(1, { title: 'Demo' }), task(2, { title: 'Rough-in', start_on: '2026-11-04', due_on: '2026-11-05' }), task(3, { title: 'Inspection', is_milestone: true, duration_days: 0, start_on: '2026-11-05', due_on: '2026-11-05' })];
const links: SchedDep[] = [{ pred_id: 't1', succ_id: 't2', dep_type: 'FS', lag_days: 0 }, { pred_id: 't2', succ_id: 't3', dep_type: 'FS', lag_days: 0 }];

describe('job Gantt permissions', () => {
  it('an editor gets the grid, drag handles and the edit tools', () => {
    const html = wrap(<Gantt {...props(bundle(three, links))} />);
    expect(html).toContain('role="treegrid"');
    expect(html).toContain('aria-readonly="false"');
    expect(html).toContain('Add task');
    expect(html).toContain('Set baseline');
    expect(html).toContain('gx-dot');
    expect(html).toContain('gx-grip');
    expect(html).toContain('Rough-in');
    expect(html).toContain('>1<'); // predecessor text "1" for Rough-in
  });

  it('Labor and view-only seats see the same schedule read-only', () => {
    const html = wrap(<Gantt {...props(bundle(three, links), { canEdit: false })} />);
    expect(html).toContain('View only.');
    expect(html).toContain('aria-readonly="true"');
    expect(html).not.toContain('Add task');
    expect(html).not.toContain('Set baseline');
    expect(html).not.toContain('gx-dot');
    expect(html).not.toContain('gx-grip');
    expect(html).toContain('Export'); // reading tools stay
    expect(html).toContain('Print 11×17');
  });

  it('without the 1112 engine the Gantt is a read-only preview drawn by the client CPM', () => {
    const legacy = three.map((t) => ({ ...t, cpm_at: null, total_float: null, is_critical: false }));
    const html = wrap(<Gantt {...props(bundle(legacy, links, { engine: false }))} />);
    expect(html).toContain('Read-only preview.');
    expect(html).not.toContain('Add task');
    expect(html).not.toContain('gx-dot');
  });

  it('a loop in loaded data is named, not a crash', () => {
    const html = wrap(<Gantt {...props(bundle(three, [...links, { pred_id: 't3', succ_id: 't1', dep_type: 'FS', lag_days: 0 }], { engine: false }))} />);
    expect(html).toContain('This schedule has a loop.');
    expect(html).toMatch(/These links make a loop: .*Demo.*→/);
  });
});

describe('task panel money', () => {
  const rows = buildOutline([task(1, { title: 'Cabinets', billing_amount_cents: 125_000 })]);
  const base = {
    row: rows[0]!, rows, deps: [], crews: [], cal: DEFAULT_CALENDAR, today: TODAY, baseline: null, canEdit: true, field: false, busy: false,
    onClose: () => {}, onSelect: () => {}, onUpdate: async () => true, onLinks: async () => null, onPush: () => {}, onDelete: async () => {},
  };
  it('hides the billing amount without projects.contract_value', () => {
    expect(wrap(<TaskPanel {...base} showBilling={false} />)).not.toContain('Billing amount');
  });
  it('shows it with the capability', () => {
    const html = wrap(<TaskPanel {...base} showBilling />);
    expect(html).toContain('Billing amount');
    expect(html).toContain('1,250.00');
  });
  it('field mode gives supervisors the big update buttons', () => {
    const html = wrap(<TaskPanel {...base} showBilling={false} field />);
    expect(html).toContain('Started today');
    expect(html).toContain('Push 1 week');
    expect(wrap(<TaskPanel {...base} showBilling={false} field canEdit={false} />)).not.toContain('Started today');
  });
});

describe('empty schedule', () => {
  const tpls = [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Bath remodel', description: null, task_count: 30, job_type_keys: [] },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Kitchen remodel', description: null, task_count: 38, job_type_keys: [] },
  ];
  it('offers the job type’s template', () => {
    const html = wrap(<Gantt {...props(bundle([], [], { templates: tpls }))} />);
    expect(html).toContain('Start from the Kitchen remodel template');
    expect(html).toContain('Add the first task');
  });
  it('a read-only seat is told who builds it, with no actions', () => {
    const html = wrap(<Gantt {...props(bundle([], [], { templates: tpls }), { canEdit: false })} />);
    expect(html).toContain('No schedule yet');
    expect(html).not.toContain('Start from');
    expect(html).not.toContain('Add the first task');
  });
});

describe('2,000 tasks', () => {
  const n = 2000;
  const big = Array.from({ length: n }, (_, i) =>
    task(i, {
      parent_task_id: i % 25 === 0 ? null : `t${i - (i % 25)}`,
      title: `Task ${i}`,
      start_on: `2026-${String(11 + Math.floor((i % 50) / 25)).padStart(2, '0')}-${String(2 + (i % 20)).padStart(2, '0')}`,
      due_on: `2026-${String(11 + Math.floor((i % 50) / 25)).padStart(2, '0')}-${String(3 + (i % 20)).padStart(2, '0')}`,
    }),
  );
  const deps: SchedDep[] = [];
  for (let i = 2; i < n; i++) if (i % 25 > 1) deps.push({ pred_id: `t${i - 1}`, succ_id: `t${i}`, dep_type: 'FS', lag_days: 0 });

  it('renders under a second and draws only the rows in view', () => {
    wrap(<Gantt {...props(bundle(big.slice(0, 50), deps.filter((d) => +d.succ_id.slice(1) < 50)))} />); // warm up
    const t0 = performance.now();
    const html = wrap(<Gantt {...props(bundle(big, deps))} />);
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.info(`[perf] Gantt first render, ${n} tasks / ${deps.length} links: ${ms.toFixed(0)} ms (server render incl. outline + CPM)`);
    expect(ms).toBeLessThan(1000);
    const rowsDrawn = html.match(/class="gx-row[ "]/g)?.length ?? 0;
    expect(rowsDrawn).toBeGreaterThan(10);
    expect(rowsDrawn).toBeLessThan(45);
    expect(html).toContain(`aria-rowcount="${n + 1}"`);
  });
});

describe('global schedule', () => {
  const jobs = [
    { id: J, label: '1042 · Smith kitchen', companyId: 'a', company: 'Heartland', pmId: 'u1', pm: 'Dana Lee', stage: 'In progress', plannedStart: '2026-11-02', plannedFinish: '2026-12-18' },
    { id: '00000000-0000-4000-8000-000000000002', label: '1043 · Ortiz bath', companyId: 'a', company: 'Heartland', pmId: null, pm: null, stage: 'Scheduled', plannedStart: null, plannedFinish: null },
  ];
  const base = { jobs, summaries: [{ job_id: J, start_on: '2026-11-02', finish_on: '2026-12-18', baseline_finish: '2026-12-11', task_count: 38, open_count: 30, critical_count: 12, pct_complete: 0.2, late_count: 2 }], lookahead: [], crews: [{ id: 'c1', name: 'Framing crew', capacity_hours: 8 }], load: [], engine: true, from: '2026-10-26', today: TODAY, multi: true, initialCrew: null };

  it('stacks the jobs with their summary bars and filters', () => {
    const html = wrap(<GlobalSchedule {...base} view="jobs" />);
    expect(html).toContain('1042 · Smith kitchen');
    expect(html).toContain('38 tasks');
    expect(html).toContain('Project manager');
    expect(html).toContain('No PM yet');
    expect(html).toContain('All companies');
  });

  it('the look-ahead shows constraint reasons in words', () => {
    const html = wrap(
      <GlobalSchedule
        {...base}
        view="lookahead"
        lookahead={[{ task_id: 't1', job_id: J, title: 'Set cabinets', start_on: '2026-10-28', due_on: '2026-10-30', status: 'TODO', pct_complete: null, crew_id: 'c1', crew_name: 'Framing crew', trade: 'Carpentry', is_critical: true, constraints: [{ kind: 'material', label: 'Material not received' }, { kind: 'submittal', label: 'Submittal not approved' }] }]}
      />,
    );
    expect(html).toContain('Set cabinets');
    expect(html).toContain('Material not received');
    expect(html).toContain('Submittal not approved');
    expect(html).toContain('1 held by a constraint');
  });

  it('the crew board says over-booked in words', () => {
    const html = wrap(<GlobalSchedule {...base} view="crews" load={[{ resource_kind: 'crew', resource_id: 'c1', resource_name: 'Framing crew', day: '2026-10-27', hours: 11, capacity_hours: 8, task_count: 2 }]} />);
    expect(html).toContain('Framing crew');
    expect(html).toContain('over by 3');
    expect(html).toContain('1 over-booked days');
  });

  it('an empty look-ahead says what to do', () => {
    expect(wrap(<GlobalSchedule {...base} view="lookahead" />)).toContain('Nothing scheduled in these three weeks');
  });
});
