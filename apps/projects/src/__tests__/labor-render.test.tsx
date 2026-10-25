/**
 * SSR smoke for the 1108 screens: Settings → Labor rates (cost vs estimating side by side and
 * the rule), an estimate labor line (overhead as its own component), and the time list
 * (approve / unapprove, pinned rate, "Sent to Merit Books" only with an event).
 */
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MeritProvider } from '@meritbooks/merit-ui';
import { DEFAULT_VOCAB } from '@meritbooks/industry-packs';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { ShellProvider } from '@/components/shell/ShellContext';
import { LaborRatesEditor } from '@/components/settings/LaborRatesEditor';
import { EstimateTab } from '@/components/money/EstimateTab';
import { TimeView } from '@/components/ops/records/TimeView';
import { LABOR_COST_RULE } from '@/lib/pm/labor/math';
import type { LaborRateRow } from '@/lib/pm/labor/types';
import type { EstimateLineRow, EstimateRow } from '@/lib/pm/money/types';
import type { TimeEntryRow } from '@/lib/pm/ops/types';
import type { CostCodeRow } from '@/lib/pm/types';

const L = 'aaaaaaaa-0000-4000-8000-00000000000a';
const J = '0bf579d0-7e25-421c-956c-4f1be58fa640';
const wrap = (el: ReactElement, readOnly = false) =>
  renderToString(<MeritProvider><ShellProvider value={{ vocab: { ...DEFAULT_VOCAB }, companies: [], activeCompanyId: L, readOnly, setCrumbs: () => {} }}>{el}</ShellProvider></MeritProvider>);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

const card = (o: Partial<LaborRateRow>): LaborRateRow => ({
  rate_card_id: 'c1', location_id: L, key: 'carpenter', label: 'Carpenter', base_rate_cents: 3000, card_burden_pct: null, card_overhead_pct: null,
  burden_pct: 0.25, overhead_pct: 0.15, burden_inherited: true, overhead_inherited: true, cost_rate_cents: 3750, estimating_rate_cents: 4313,
  overhead_rate_cents: 563, bill_rate_cents: 6500, effective_from: '2026-10-21', is_active: true, employee_count: 2, updated_at: '2026-10-21T12:00:00Z', ...o,
});

describe('settings → labor rates', () => {
  it('shows cost rate next to estimating rate, the rule, and a no-base card', () => {
    const html = wrap(<LaborRatesEditor companyId={L} settings={{ location_id: L, default_burden_pct: 0.25, default_overhead_pct: 0.15, notes: null, updated_by: 'u', updated_at: '2026-10-21T12:00:00Z' }}
      rates={[card({}), card({ rate_card_id: 'c2', key: 'crew', label: 'Crew', base_rate_cents: null, cost_rate_cents: null, estimating_rate_cents: null, overhead_rate_cents: null, bill_rate_cents: null })]}
      employees={[{ id: 'e1', name: 'Wade Worker' }]} employeeCards={[{ employee_id: 'e1', location_id: L, rate_card_id: 'c1' }]} />);
    expect(html).toContain(esc(LABOR_COST_RULE));
    expect(html).toContain('Cost rate');
    expect(html).toContain('Estimating rate');
    expect(html).toContain('37.50');
    expect(html).toContain('43.13');
    expect(html).toContain('incl. <!-- -->5.63<!-- --> overhead');
    expect(html).toContain('each person’s rate');
    expect(html).toContain('Who is on which card');
    expect(html).toContain('Add rate card');
  });
  it('empty state before any card', () => {
    expect(wrap(<LaborRatesEditor companyId={L} settings={null} rates={[]} employees={[]} employeeCards={[]} />)).toContain('No rate cards yet');
  });
});

const codes: CostCodeRow[] = [{ id: 'cc02', location_id: L, job_id: null, parent_id: null, code: '02', name: 'Demolition labor', cost_type: 'LABOR', role_hint: null, install_id: null, source_pack: null, sort: 0, is_active: true }];
const est: EstimateRow = {
  id: 'e1', location_id: L, job_id: J, customer_id: null, number: 'EST-ACM-2026-0001', version: 1, title: 'Remodel', status: 'DRAFT', retainage_pct: null,
  valid_until: null, notes: null, total_cents: 78000, cost_total_cents: 45000, supersedes_id: null, budget_id: null, sent_at: null, accepted_at: null,
  accepted_by: null, declined_at: null, decline_reason: null, created_by: 'u1', created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z',
};
const laborLine: EstimateLineRow = {
  id: 'l1', estimate_id: 'e1', line_no: 1, cost_code_id: 'cc02', description: 'Carpenter', qty: 12, uom: 'HR', unit_cost_cents: 4313, unit_price_cents: 6500,
  cost_cents: 45000, amount_cents: 78000, is_allowance: false, sort: 0, labor_rate_card_id: 'c1', labor_hours: 12,
  ext: { _labor: { rate_card_id: 'c1', label: 'Carpenter', hours: 12, cost_rate_cents: 3750, estimating_rate_cents: 4313, overhead_rate_cents: 563, cost_cents: 45000, overhead_cents: 6756, estimating_cents: 51756, burden_pct: 0.25, overhead_pct: 0.15 } },
};

describe('estimate labor line', () => {
  it('unit cost = estimating rate with the overhead part; cost = job cost; overhead recovered in margin', () => {
    const html = wrap(<EstimateTab jobId={J} estimates={[est]} lines={[laborLine]} costCodes={codes} contractCents={0} budgetCents={null} booksPresent rateCards={[card({})]} />);
    expect(html).toContain('Labor from a rate card');
    expect(html).toContain('43.13');
    expect(html).toContain('37.50<!-- --> + <!-- -->5.63<!-- --> overhead');
    expect(html).toContain('+ <!-- -->67.56<!-- --> overhead in bid');
    expect(html).toContain('Overhead recovered');
    expect(html).toContain(esc(LABOR_COST_RULE));
  });
  it('no rate cards: no labor mode', () => {
    expect(wrap(<EstimateTab jobId={J} estimates={[est]} lines={[]} costCodes={codes} contractCents={0} budgetCents={null} booksPresent />)).not.toContain('Labor from a rate card');
  });
});

const entry = (o: Partial<TimeEntryRow>): TimeEntryRow => ({
  id: 't1', job_id: J, employee_id: 'e1', user_id: null, work_date: '2026-10-20', hours: 8, pay_type: 'REG', cost_code_id: 'cc02', work_order_id: null, operation_id: null,
  billable: true, notes: null, approval_state: 'SUBMITTED', approved_at: null, created_by: 'user_pm', cost_rate_cents: null, bill_rate_cents: null, approved_by: null, event_id: null,
  late_tap: false, late_tap_minutes: null, late_ack_at: null, ...o,
});

describe('time list: approve, unapprove, pinned rate, sent to Books', () => {
  const base = {
    weekStart: '2026-10-19', today: '2026-10-21', employees: [{ id: 'e1', clerk_user_id: 'user_worker', first_name: 'Wade', last_name: 'Worker', title: null, is_active: true }],
    meEmployeeId: null, jobs: [{ id: J, label: 'ACM-2026-0001 Remodel', companyId: L, open: true, customerId: null, customer: null }] as never, costCodes: codes, workOrders: [], operations: [],
  };
  it('a reviewer sees Approve; approved + emitted shows the rate and "Sent to Merit Books"', () => {
    const html = wrap(<TimeView {...base} meUserId="user_pm2" entries={[
      entry({}),
      entry({ id: 't2', approval_state: 'APPROVED', cost_rate_cents: 3750, approved_by: 'user_pm2', approved_at: '2026-10-21T12:00:00Z', event_id: 'ev1' }),
      entry({ id: 't3', approval_state: 'APPROVED', cost_rate_cents: 5625, pay_type: 'OT', hours: 2, approved_by: 'user_pm2', approved_at: '2026-10-21T12:00:00Z', event_id: null }),
    ]} />);
    expect(html).toContain('Approve all shown');
    expect(html).toContain('>Approve<');
    expect(html).toContain('Unapprove');
    expect(html).toContain('37.50/h');
    expect(html).toContain('56.25/h');
    expect(html.match(/Sent to Merit Books/g)?.length).toBe(1);
    expect(html).not.toMatch(/later release/i);
  });
  it('a late phone tap shows "entered N h late", is left out of Approve all and is reviewed one by one', () => {
    const html = wrap(<TimeView {...base} meUserId="user_pm2" entries={[
      entry({ id: 'late', late_tap: true, late_tap_minutes: 210 }),
      entry({ id: 'acked', late_tap: true, late_tap_minutes: 90, late_ack_at: '2026-10-21T13:00:00Z' }),
    ]} />);
    expect(html).toContain('entered 3.5 h late');
    expect(html).toContain('entered 1.5 h late');
    expect(html).toContain('acknowledged');
    expect(html).toContain('Review late time');
    expect(html).toContain('entered late from the phone');
    expect(html).toContain('<span class="t-cap">1<!-- --> ready to approve');   // only the acknowledged one
  });
  it('the preparer cannot approve their own entry', () => {
    const html = wrap(<TimeView {...base} meUserId="user_pm" entries={[entry({})]} />);
    expect(html).not.toContain('Approve all shown');
    expect(html).toContain('another person approves it');
  });
});
