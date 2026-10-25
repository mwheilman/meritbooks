/**
 * SSR smoke test for the residential screens (1119): each renders with realistic rows in the shell
 * without throwing, money hides for a role without it (a dash, never $0), and the empty states say
 * what to do next.
 */
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MeritProvider } from '@meritbooks/merit-ui';
import { DEFAULT_VOCAB } from '@meritbooks/industry-packs';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/proposals',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { ShellProvider } from '@/components/shell/ShellContext';
import { ALL_MONEY, NO_MONEY, type MoneyVis } from '@/components/money/visibility';
import { ProposalsList } from '@/components/residential/ProposalsList';
import { ProposalBuilder } from '@/components/residential/ProposalBuilder';
import { SelectionChooser } from '@/components/residential/SelectionChooser';
import { HomeWorkspace } from '@/components/residential/HomeWorkspace';
import { BuilderBoard } from '@/components/residential/BuilderBoard';
import { LotDesk } from '@/components/residential/LotDesk';
import { CommunitiesSetup } from '@/components/residential/CommunitiesSetup';
import type { BuilderBundle, HomeWorkspace as HomeBundle, ProposalBundle, ProposalListItem } from '@/lib/residential/queries';
import type { ProposalRow, SelectionPreview } from '@/lib/residential/types';
import type { Vocabulary } from '@/lib/pm/vocab';

const A = '11111111-1111-4111-8111-111111111111';
const J = '00000000-0000-4000-8000-000000000001';
const P = '22222222-2222-4222-8222-222222222222';
const DAY = '2026-10-20';

function wrap(el: ReactElement, money: MoneyVis = ALL_MONEY): string {
  return renderToString(
    <MeritProvider>
      <ShellProvider value={{ vocab: { ...DEFAULT_VOCAB } as Vocabulary, companies: [], activeCompanyId: A, readOnly: false, money, setCrumbs: () => {} }}>{el}</ShellProvider>
    </MeritProvider>,
  );
}

const proposal = (over: Partial<ProposalRow> = {}): ProposalRow => ({
  id: P, location_id: A, job_id: J, estimate_id: '33333333-3333-4333-8333-333333333333', lead_id: null, customer_id: null, number: 'P-1001', version: 1,
  title: 'Kitchen remodel', job_type_key: 'kitchen_remodel', contract_type: 'FIXED_PRICE', fee_pct: null, fee_cents: null, gmp_cents: null, savings_split_pct: null,
  tax_contract_form: 'LUMP_SUM_IMPROVEMENT', tax_rate: 0.07, state_code: 'IA', scope_narrative: 'Full gut of the kitchen.', inclusions: ['Permit'], exclusions: ['Painting'],
  terms: null, cancellation_notice: 'You may cancel within three business days.', cancel_days: 3, deposit_pct: 0.1, deposit_cents: null, deposit_refundable: false,
  design_proposal_id: null, credit_to_build: false, retainer_credit_cents: 0, schedule_template_key: 'kitchen_remodel', planned_start: '2026-11-02', valid_until: '2026-11-15',
  status: 'DRAFT', base_price_cents: 4_850_000, options_price_cents: 320_000, allowance_cents: 900_000, contingency_cents: 0, contingency_pct: null, fee_total_cents: 0,
  tax_cents: 0, use_tax_cents: 98_000, total_cents: 5_170_000, grand_total_cents: 5_170_000, cost_cents: 3_620_000, overhead_cents: 410_000, deposit_due_cents: 517_000,
  sent_at: null, first_viewed_at: null, last_viewed_at: null, view_count: 0, file_id: null, envelope_id: null, signed_at: null, signed_by_name: null, sign_method: null,
  accepted_at: null, declined_at: null, decline_reason: null, result: {}, created_by: null, created_at: '2026-10-18T12:00:00Z', updated_at: '2026-10-19T12:00:00Z', ...over,
});

const bundle = (over: Partial<ProposalRow> = {}): ProposalBundle => ({
  proposal: proposal(over),
  options: [{ id: '44444444-4444-4444-8444-444444444441', proposal_id: P, kind: 'ALTERNATE', group_key: 'tops', tier: 'BETTER', label: 'Quartz tops', description: null, image_url: null, is_selected: true, sort: 1 }],
  lines: [
    { id: '55555555-5555-4555-8555-555555555551', proposal_id: P, option_id: null, catalog_item_id: null, assembly_id: null, cost_code_id: 'cc', cost_type: 'LABOR', room: 'Kitchen', description: 'Demolition',
      qty: 16, uom: 'HR', waste_pct: 0, unit_cost_cents: null, markup_pct: 0.5, margin_pct: null, unit_price_cents: null, labor_rate_card_id: 'r', labor_hours: 16, cost_cents: 67_200, overhead_cents: 20_160, price_cents: 131_040,
      is_allowance: false, allowance_category: null, selection_titles: [], is_contingency: false, tax_category: 'LABOR', client_visible: true, sort: 1 },
    { id: '55555555-5555-4555-8555-555555555552', proposal_id: P, option_id: null, catalog_item_id: null, assembly_id: null, cost_code_id: 'cc', cost_type: 'MATERIALS', room: 'Kitchen', description: 'Tile allowance',
      qty: 1, uom: 'LS', waste_pct: 0, unit_cost_cents: 600_000, markup_pct: null, margin_pct: null, unit_price_cents: 900_000, labor_rate_card_id: null, labor_hours: null, cost_cents: 600_000, overhead_cents: 0, price_cents: 900_000,
      is_allowance: true, allowance_category: 'Tile', selection_titles: ['Backsplash', 'Floor tile'], is_contingency: false, tax_category: 'MATERIAL', client_visible: true, sort: 2 },
  ],
  schedule: [
    { id: 's1', job_id: J, proposal_id: P, seq: 1, label: 'Deposit', kind: 'DEPOSIT', pct: 0.1, amount_cents: null, added_cents: 0, trigger_ref: null, task_id: null, billing_task_id: null, requires_photo: false, requires_checklist: false, status: 'PLANNED', hold_reason: null, billing_request_id: null, deposit_request_id: null },
    { id: 's2', job_id: J, proposal_id: P, seq: 2, label: 'Final', kind: 'FINAL', pct: null, amount_cents: null, added_cents: 0, trigger_ref: null, task_id: null, billing_task_id: null, requires_photo: false, requires_checklist: true, status: 'PLANNED', hold_reason: null, billing_request_id: null, deposit_request_id: null },
  ],
  job: { id: J, job_number: '1042', name: 'Smith kitchen', customer_name: 'Pat Smith' },
  snapshots: [],
  envelope: null,
});

describe('residential screens render', () => {
  it('proposals list: rows with prices, and the empty state', () => {
    const row: ProposalListItem = { id: P, location_id: A, job_id: J, number: 'P-1001', version: 2, title: 'Kitchen remodel', contract_type: 'FIXED_PRICE', status: 'SENT', total_cents: 5_170_000,
      grand_total_cents: 5_170_000, sent_at: '2026-10-19T12:00:00Z', view_count: 0, last_viewed_at: null, accepted_at: null, valid_until: '2026-11-15', updated_at: '2026-10-19T12:00:00Z', job_number: '1042', customer_name: 'Pat Smith' };
    const html = wrap(<ProposalsList rows={[row]} leads={[]} jobs={[]} companies={[{ id: A, name: 'Crystal' }]} today={DAY} canCreate />);
    expect(html).toContain('Out for signature');
    expect(wrap(<ProposalsList rows={[]} leads={[]} jobs={[]} companies={[]} today={DAY} canCreate />)).toContain('No proposals yet');
  });

  it('proposal builder: totals, cost and margin for a money holder; none of it without', () => {
    const html = wrap(<ProposalBuilder bundle={bundle()} catalog={{ items: [], assemblies: [] }} today={DAY} canEdit />);
    expect(html).toContain('51,700.00');
    expect(html).toContain('Margin');
    expect(html).toContain('Right to cancel');
    expect(html).toContain('Send proposal');
    const hidden = wrap(<ProposalBuilder bundle={bundle()} catalog={{ items: [], assemblies: [] }} today={DAY} canEdit={false} />, NO_MONEY);
    expect(hidden).not.toContain('51,700.00');
    expect(hidden).not.toContain('Margin');
    expect(hidden).toContain('Prices are hidden for your role');
    expect(hidden).not.toContain('Send proposal');
  });

  it('accepted proposal links to the home workspace', () => {
    const b = bundle({ status: 'ACCEPTED', result: { job_id: J, estimate_id: 'e', contract_cents: 5_170_000, grand_total_cents: 5_170_000, deposit_cents: 517_000, selections_created: 3,
      household_invites: 2, warnings: ['No schedule template for kitchen'], method: 'IN_PERSON', signer: 'Pat Smith', payment_schedule: [] } });
    const html = wrap(<ProposalBuilder bundle={b} catalog={{ items: [], assemblies: [] }} today={DAY} canEdit />);
    expect(html).toContain(`/homes/${J}`);
    expect(html).toContain('No schedule template for kitchen');
  });

  it('selection chooser shows the allowance delta before choosing', () => {
    const preview: SelectionPreview = { selection_id: 's', job_id: J, title: 'Backsplash', category: 'Tile', room: 'Kitchen', status: 'OPEN', due_on: null, needed_by_on: '2026-11-01', at_risk: true,
      allowance_id: 'a', shared: true, allowance_cents: 900_000, used_by_others_cents: 400_000, remaining_cents: 500_000, money_visible: true,
      options: [{ id: 'o1', label: 'Zellige', description: null, vendor_id: null, vendor_sku: 'ZL-12', finish: 'Gloss', image_url: 'https://example.com/z.jpg', vendor_url: null, lead_time_days: 28,
        is_recommended: true, qty: 1, uom: 'LS', amount_cents: 684_000, over_cents: 184_000, under_cents: 0, needed_by_on: '2026-10-01' }] };
    const html = wrap(<SelectionChooser preview={preview} today={DAY} canApprove />);
    expect(html).toContain('1,840.00 over the allowance');
    expect(html).toContain('Choose this');
    expect(html).toContain('Decide now');
  });

  it('home workspace renders every tab source without throwing', () => {
    const b: HomeBundle = {
      job: { id: J, job_number: '1042', name: 'Smith kitchen', customer_name: 'Pat Smith', location_id: A }, profile: null, rrp: null, household: [], checks: [], chainSteps: [], walks: [],
      permits: [], inspections: [], vendors: {}, schedule: bundle().schedule,
      changeOrders: [{ id: 'c', job_id: J, number: 'CO-3', title: 'Rot under sink', co_type: 'DEMO_DISCOVERY', stage: 'DRAFT', reason_code: null, stop_work: true, emergency: false, signed_at: null, signer_name: null, age_days: 1, exposure_state: 'unpriced', work_logged_unsigned: true }],
      trades: [{ id: 't', job_id: J, task_id: 'k', task_title: 'Cabinet install', start_on: '2026-10-21', vendor_id: 'v', status: 'NOTIFIED', proposed_on: null, response_note: null, at_risk: true, date_moved_since_confirm: false }],
      decisions: [{ kind: 'selection', id: 's', title: 'Backsplash', due_on: '2026-10-19', at_risk: true, allowance_cents: 900_000 }],
    };
    const html = wrap(<HomeWorkspace bundle={b} today={DAY} can={{ edit: true, billing: true, changeOrders: true, selections: true }} />);
    expect(html).toContain('stop-work change order');
    expect(html).toContain('unconfirmed inside 72 hours');
    expect(html).toContain('/selections/s');
    for (const tab of ['changes', 'trades', 'payments', 'home', 'site', 'closeout'] as const) {
      expect(() => wrap(<HomeWorkspace bundle={b} today={DAY} initialTab={tab} can={{ edit: true, billing: true, changeOrders: true, selections: true }} />)).not.toThrow();
    }
  });

  it('builder board, lot desk and communities setup', () => {
    const empty: BuilderBundle = { communities: [], lots: [], plans: [], options: [], specs: [] };
    expect(wrap(<BuilderBoard bundle={empty} />)).toContain('No communities yet');
    const b: BuilderBundle = {
      communities: [{ id: 'c', location_id: A, code: 'PR', name: 'Prairie Ridge', city: 'Ankeny', state: 'IA', status: 'ACTIVE' }],
      lots: [{ lot_id: 'l', location_id: A, community_id: 'c', community: 'Prairie Ridge', lot_number: '14', block: '2', status: 'STARTED', is_spec: false, plan_id: 'p', plan_code: '2410', plan_name: 'Aspen',
        standard_cycle_days: 120, job_id: J, started_on: '2026-06-01', completed_on: null, cycle_days: 141, current_stage: 'Drywall', pct_complete: 0.62, behind_standard: true }],
      plans: [{ id: 'p', location_id: A, code: '2410', name: 'Aspen', beds: 4, baths: 2.5, sqft: 2410, base_cost_cents: 28_000_000, target_margin_pct: 0.22, standard_cycle_days: 120, schedule_template_key: 'production_home', job_type_key: null, is_active: true }],
      options: [{ id: 'o', location_id: A, code: 'BSMT', name: 'Finished basement', category: 'Structural', cutoff_stage: 'PRE_FRAME', is_structural: true, cost_cents: 2_500_000, is_active: true }],
      specs: [],
    };
    expect(wrap(<BuilderBoard bundle={b} />)).toContain('behind the standard cycle');
    const desk = wrap(<LotDesk lot={{ id: 'l', lot_number: '14', block: '2', status: 'STARTED', plan_id: 'p', elevation_id: null, job_id: J, premium_cents: 0, is_spec: false, current_stage: 'Drywall' }} houseStage="PRE_TRIM"
      agreement={{ id: 'pa', lot_id: 'l', job_id: J, customer_id: 'cu', number: 'PA-7', plan_id: 'p', elevation_id: null, base_price_cents: 39_900_000, elevation_cents: 0, lot_premium_cents: 0, options_cents: 0,
        incentives_cents: 0, fees_cents: 0, total_cents: 39_900_000, earnest_money_cents: 1_000_000, earnest_in_escrow: true, contingencies: [], status: 'SIGNED', signed_at: '2026-05-20T12:00:00Z', signed_by_name: 'Lee' }}
      paOptions={[]} addenda={[]} packageItems={[]} elevations={[]} plans={b.plans} options={b.options} customers={[]} vendors={{}} today={DAY} can={{ sell: true, release: true }} />);
    expect(desk).toContain('passed, structural');
    expect(desk).toContain('Purchase agreement');
    expect(wrap(<CommunitiesSetup bundle={b} companyId={A} vendors={[]} canEdit canAgreements />)).toContain('Prairie Ridge');
    expect(wrap(<CommunitiesSetup bundle={b} companyId={null} vendors={[]} canEdit canAgreements={false} />)).toContain('Switch to one company');
  });
});
