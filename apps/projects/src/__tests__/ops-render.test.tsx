/**
 * SSR smoke test for the industry-module views: each renders with realistic rows, in the
 * shell, without throwing (merit-ui asserts banned state copy and hotkey conflicts in dev).
 */
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MeritProvider } from '@meritbooks/merit-ui';
import { DEFAULT_VOCAB } from '@meritbooks/industry-packs';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/dispatch',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { ShellProvider } from '@/components/shell/ShellContext';
import { ContinuationSheet } from '@/components/ops/draws/ContinuationSheet';
import { DispatchBoard } from '@/components/ops/dispatch/DispatchBoard';
import { WorkOrderQueue } from '@/components/ops/work-orders/WorkOrderQueue';
import { PunchView } from '@/components/ops/records/PunchView';
import { LogsView } from '@/components/ops/records/LogsView';
import { DrawsInFlightWidget, SelectionsDueWidget, ShopLoadWidget, SignalsWidget, TodaysVisitsWidget } from '@/components/ops/widgets';
import type { JobOption } from '@/lib/pm/ops/scope';
import type { AssignmentRow, DrawLineStatusRow, WorkOrderRow } from '@/lib/pm/ops/types';
import type { Vocabulary } from '@/lib/pm/vocab';

const A = '11111111-1111-4111-8111-111111111111';
const J = '00000000-0000-4000-8000-000000000001';
const E = '33333333-3333-4333-8333-333333333333';
const DAY = '2026-10-20';

function wrap(el: ReactElement, vocab: Partial<Vocabulary> = {}): string {
  return renderToString(
    <MeritProvider>
      <ShellProvider value={{ vocab: { ...DEFAULT_VOCAB, ...vocab } as Vocabulary, companies: [], activeCompanyId: A, readOnly: false, setCrumbs: () => {} }}>{el}</ShellProvider>
    </MeritProvider>,
  );
}

const job: JobOption = { id: J, label: '1042 · Smith furnace', companyId: A, company: null, customerId: null, customer: 'Pat Smith', open: true, jobTypeKey: 'service' };

const wo = (over: Partial<WorkOrderRow> = {}): WorkOrderRow => ({
  id: '44444444-4444-4444-8444-444444444444', location_id: A, job_id: J, number: 'WO-1042', kind: 'SERVICE', status: 'SCHEDULED', priority: 2,
  summary: 'No heat, furnace short-cycling', description: null, complaint: null, cause: null, resolution: null, outcome: null, asset_id: null,
  agreement_id: null, visit_seq: null, due_on: DAY, due_by: null, requested_start: null, requested_end: null,
  scheduled_start: '2026-10-20T14:00:00Z', scheduled_end: '2026-10-20T15:30:00Z', estimated_minutes: 90, required_skills: [], promised_on: null,
  checked_in_at: null, meter_in: null, meter_out: null, payer_type: 'CUSTOMER', payer_customer_id: null, is_callback: false, callback_of_id: null,
  follow_up_required: false, hold_reason: null, started_at: null, completed_at: null, closed_at: null, cancelled_at: null, cancel_reason: null,
  created_at: '2026-10-19T12:00:00Z', updated_at: '2026-10-19T12:00:00Z', ...over,
});
const assignment: AssignmentRow = {
  id: '55555555-5555-4555-8555-555555555555', job_id: J, work_order_id: wo().id, employee_id: E, crew_id: null,
  slot: '["2026-10-20 14:00:00+00","2026-10-20 15:30:00+00")', status: 'ASSIGNED', is_lead: true,
  dispatched_at: null, en_route_at: null, arrived_at: null, done_at: null,
};

describe('industry-module views render', () => {
  it('dispatch board with one booked visit and one in the queue', () => {
    const html = wrap(
      <DispatchBoard
        day={DAY} tz="America/Chicago" today={DAY}
        assignments={[assignment]} orders={[wo()]} crews={[]} members={[]}
        employees={[{ id: E, clerk_user_id: null, first_name: 'Ann', last_name: 'Lee', title: 'Tech', is_active: true }]}
        skills={[]} employeeSkills={[]}
        board={[{ location_id: A, day: DAY, employee_id: E, crew_id: null, assignments: 1, booked_minutes: 90, capacity_minutes: 480, available_minutes: 390 }]}
        queue={[{ location_id: A, work_order_id: '66666666-6666-4666-8666-666666666666', job_id: J, number: 'WO-1043', kind: 'SERVICE', priority: 1, summary: 'AC not cooling', requested_start: null, requested_end: null, due_on: DAY, due_by: null, estimated_minutes: 60, required_skills: [], is_overdue: false, created_at: '2026-10-19T12:00:00Z' }]}
        jobLabels={{ [J]: job.label }} companies={[{ id: A, name: 'Heartland' }]} activeCompanyId={A} focusWo={null} focusOrder={null}
      />,
    );
    expect(html).toContain('Ann Lee');
    expect(html).toContain('WO-1043');
  });

  it('work-order queue, labelled as repair orders for a dealer', () => {
    const html = wrap(
      <WorkOrderQueue
        orders={[wo({ kind: 'REPAIR_ORDER', number: 'RO-77' })]} assignments={[assignment]} claims={[]} assets={[]} employees={{ [E]: 'Ann Lee' }}
        jobs={[job]} jobTypes={[]} companies={[{ id: A, name: 'Clive' }]} defaultCompanyId={A} packKey="equipment_dealer" skills={[]} customers={{}}
        tz="America/Chicago" today={DAY} capped={false} focusId={null} openNew={false} initialBand={null} initialView="orders"
      />,
      { job: 'Repair order', jobs: 'Repair orders', work_order: 'RO line', work_orders: 'RO lines' },
    );
    expect(html).toContain('RO-77');
    expect(html).not.toContain('RO lines');
  });

  it('G703 continuation sheet', () => {
    const row: DrawLineStatusRow = {
      job_id: J, draw_schedule_id: 's', draw_budget_line_id: 'l1', line_no: 1, description: 'Sitework', category: 'HARD', original_cents: 10_000_000,
      revised_cents: 10_000_000, drawn_cents: 3_000_000, open_request_cents: 2_000_000, remaining_cents: 5_000_000, pct_drawn: 0.3, retainage_held_cents: 300_000,
    };
    const html = wrap(<ContinuationSheet rows={[row]} openDrawNumber={4} />);
    expect(html).toContain('This draw (#4)');
    expect(html).toContain('50,000.00');
  });

  it('punch list and daily logs', () => {
    expect(wrap(<PunchView items={[{ id: 'p1', job_id: J, kind: 'PUNCH', title: 'Touch up paint', description: null, status: 'OPEN', area: 'Kitchen', responsible_vendor_id: null, assignee_user_id: null, due_on: '2026-10-18', closed_at: null, billable: false, created_at: '2026-10-10T12:00:00Z' }]} jobs={[job]} vendors={{}} today={DAY} />)).toContain('Touch up paint');
    expect(wrap(<LogsView logs={[]} jobs={[job]} loggedJobIds={[J]} today={DAY} meUserId="u" names={{}} />)).toContain('Not logged today');
  });

  it('home widgets render their loading state on the server', () => {
    const html = wrap(<>{[<SignalsWidget key="s" />, <TodaysVisitsWidget key="v" />, <ShopLoadWidget key="p" />, <SelectionsDueWidget key="d" />, <DrawsInFlightWidget key="f" />]}</>, { work_order: 'Visit', work_orders: 'Visits' });
    expect(html).toContain('Signals');
    expect(html).toContain('Today&#x27;s visits');
    expect(html).toContain('Shop load');
  });
});
