/**
 * SSR render of every Wave C commercial screen with realistic rows (and the empty states), in the
 * shell: the screens render without throwing, show the figures and words a user reads, and
 * leave money out when the caller may not see it.
 */
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MeritProvider } from '@meritbooks/merit-ui';
import { DEFAULT_VOCAB } from '@meritbooks/industry-packs';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/pay-apps',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { ShellProvider } from '@/components/shell/ShellContext';
import { ALL_MONEY, NO_MONEY, type MoneyVis } from '@/components/money/visibility';
import type { Vocabulary } from '@/lib/pm/vocab';
import type { JobOption } from '@/lib/pm/ops/scope';
import type { CalendarRow, CostDetailRow, PayableRetainageRow, RetainageBothRow, SheetLine } from '@/lib/commercial/screen-logic';
import type {
  CloseoutItem, Correspondence, DirectoryEntry, ForemanPlan, Incident, Inspection, Jha, Observation, PayAppListRow, PayAppWorkspaceData, ProjectTemplate,
  ReviewPackage, SpecSection, ToolboxTalk, TradeProposal, Transmittal,
} from '@/lib/commercial/screen-types';
import { PayAppsView } from '@/components/commercial/PayAppsView';
import { PayAppWorkspace } from '@/components/commercial/PayAppWorkspace';
import { RetainageLedgerView } from '@/components/commercial/RetainageLedgerView';
import { BuyoutView } from '@/components/commercial/BuyoutView';
import { DirectoryView } from '@/components/commercial/DirectoryView';
import { TemplatesView } from '@/components/commercial/TemplatesView';
import { TradeProposalsView } from '@/components/commercial/TradeProposalsView';
import { CostDetailView } from '@/components/commercial/CostDetailView';
import { SpecsView } from '@/components/commercial/SpecsView';
import { CorrespondenceView } from '@/components/commercial/CorrespondenceView';
import { InspectionsView } from '@/components/commercial/InspectionsView';
import { ObservationsView } from '@/components/commercial/ObservationsView';
import { SafetyView } from '@/components/commercial/SafetyView';
import { ProductivityView } from '@/components/commercial/ProductivityView';
import { WorkforceView } from '@/components/commercial/WorkforceView';
import { ForemanPlanView } from '@/components/commercial/ForemanPlanView';
import { BillingCalendarView } from '@/components/commercial/BillingCalendarView';
import { CloseoutBoard, CloseoutJob } from '@/components/commercial/CloseoutView';
import { ReviewPackageView } from '@/components/commercial/ReviewPackageView';
import { BuyoutTab, CloseoutTab, ProductivityTab, SafetyTab } from '@/components/job/tabs/CommercialTabs';

const A = '11111111-1111-4111-8111-111111111111';
const J = '00000000-0000-4000-8000-000000000001';
const R = '22222222-2222-4222-8222-222222222222';
const V = '33333333-3333-4333-8333-333333333333';
const TODAY = '2026-10-25';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function wrap(el: ReactElement, money: MoneyVis = ALL_MONEY, readOnly = false): string {
  // React separates adjacent text with <!-- --> in SSR; tests read the text as the user does.
  return renderToString(
    <MeritProvider>
      <ShellProvider value={{ vocab: { ...DEFAULT_VOCAB } as Vocabulary, companies: [], activeCompanyId: A, readOnly, money, setCrumbs: () => {} }}>{el}</ShellProvider>
    </MeritProvider>,
  ).replace(/<!-- -->/g, '');
}

const job: JobOption = { id: J, label: '26-0533 · Mercy West tower', companyId: A, company: null, customerId: U(77), customer: 'Turner Construction', open: true, jobTypeKey: 'commercial' };
const sheet = (over: Partial<SheetLine> = {}): SheetLine => ({
  id: U(100), line_no: 1, description: 'Branch wiring', line_type: 'STANDARD', sov_line_id: U(200), scheduled_value_cents: 1_000_000, previous_work_cents: 400_000,
  this_period_work_cents: 200_000, stored_materials_cents: 50_000, previous_stored_cents: 0, total_completed_cents: 650_000, pct_complete: 0.65, balance_to_finish_cents: 350_000,
  retainage_rate: 0.05, retainage_work_to_date_cents: 30_000, retainage_stored_to_date_cents: 2_500, retainage_this_period_cents: 12_500, change_order: null, ...over,
});
const g702 = {
  job_id: J, billing_request_id: R, application_no: 7, period_end: '2026-10-31', status: 'DRAFT', original_contract_cents: 1_400_000, net_change_by_co_cents: 100_000,
  contract_sum_to_date_cents: 1_500_000, total_completed_stored_cents: 750_000, retainage_work_cents: 35_000, retainage_stored_cents: 2_500, retainage_total_cents: 37_500,
  total_earned_less_retainage_cents: 712_500, previous_certificates_cents: 380_000, current_payment_due_cents: 332_500, balance_to_finish_incl_retainage_cents: 787_500, request_net_cents: 332_500,
};

describe('owner pay applications (CGC-41/43/44)', () => {
  it('the list: stage, figures, the draft action', () => {
    const rows: PayAppListRow[] = [{ ...g702, stage: 'PENCIL_SENT', revision: 2, portal: 'TEXTURA', portal_status: 'SUBMITTED' }];
    const html = wrap(<PayAppsView rows={rows} jobs={[job]} draftable={[J]} today={TODAY} />);
    expect(html).toContain('Pencil sent');
    expect(html).toContain('3,325.00');
    expect(html).toContain('rev 2');
    expect(html).toContain('New pay application');
  });

  it('the workspace: G702, G703 with the CO line, stepper, certification and portal output', () => {
    const data: PayAppWorkspaceData = {
      jobId: J, jobLabel: job.label, requestId: R, requestStatus: 'DRAFT', periodEnd: '2026-10-31', applicationNo: 7, g702,
      lines: [sheet(), sheet({ id: U(101), line_no: 2, description: 'CO 004 — Added feeders', change_order: 'CO-004', scheduled_value_cents: 500_000, previous_work_cents: 0, this_period_work_cents: 100_000, stored_materials_cents: 0, total_completed_cents: 100_000, balance_to_finish_cents: 400_000 })],
      status: { id: U(5), job_id: J, billing_request_id: R, application_no: 7, revision: 2, stage: 'PENCIL_SENT', pencil_sent_at: '2026-10-21T15:00:00Z', pencil_sent_to: 'HGA Architects', returned_note: null, architect_name: null, certified_at: null, certified_amount_cents: null, contractor_signed_at: null, notarized_at: null, owner_approved_at: null, portal: 'TEXTURA', portal_status: 'NOT_SUBMITTED', portal_submitted_at: null, superseded_by: null },
      revisions: [{ id: U(6), revision: 1, reason: 'Owner held line 4 at 60%', totals: { net_cents: 350_000 }, created_at: '2026-10-20T12:00:00Z', lines: [] }],
      preview: { gross_earned_cents: 350_000, retainage_cents: 17_500, net_cents: 332_500, billed_to_date_cents: 400_000, earned_revenue_cents: 700_000, over_under_before_cents: -300_000, over_under_after_cents: 50_000, preconditions: [], warnings: [{ code: 'APPROVED_CO_NOT_ON_SOV', text: 'An approved change order is not on the schedule of values yet.' }] },
      settings: { billing_cutoff_day: 25, billing_form: 'TEXTURA', billing_portal_url: 'https://textura.example', retainage_step_mode: 'NEW_WORK_ONLY', stored_retainage_pct: null, architect_certification: true, notarization_required: false },
      steps: [{ from_pct: 0.5, rate: 0.05, note: null }], envelopes: [], siblings: [{ id: R, application_no: 7, revision: 2, stage: 'PENCIL_SENT', period_end: '2026-10-31' }],
    };
    const html = wrap(<PayAppWorkspace data={data} today={TODAY} canApprove />);
    for (const s of ['Application for payment', '8. Current payment due', '3,325.00', 'Continuation sheet', 'CO-004', 'Pencil sent', 'Record the certification', 'Owner returned it', 'Textura import', 'Download CSV', 'Revision 1', '5.0% from 50% complete', 'An approved change order is not on the schedule of values yet.']) {
      expect(html, s).toContain(s);
    }
  });
});

describe('money screens', () => {
  it('retainage ledger, both sides', () => {
    const both: RetainageBothRow[] = [{ job_id: J, location_id: A, receivable_held_cents: 75_000, receivable_released_cents: 0, receivable_outstanding_cents: 75_000, payable_held_cents: 30_000, payable_released_cents: 0, payable_outstanding_cents: 30_000, substantial_completion_on: '2026-10-01', receivable_release_eligible: true }];
    const payable: PayableRetainageRow[] = [{ job_id: J, commitment_id: U(3), number: 'SC-0001', vendor_id: V, held_cents: 30_000, released_cents: 0, outstanding_cents: 30_000, final_waiver_verified: false }];
    const html = wrap(<RetainageLedgerView both={both} payable={payable} vendors={{ [V]: 'Sparky Electric' }} jobs={[job]} today={TODAY} canBill canRelease />);
    expect(html).toContain('Billable now');
    expect(html).toContain('>750<');
    expect(wrap(<RetainageLedgerView both={both} payable={payable} vendors={{ [V]: 'Sparky Electric' }} jobs={[job]} today={TODAY} initialTab="payable" canBill canRelease />)).toContain('Needs final waiver');
  });

  it('buyout log with risk, and without cost visibility the money columns are gone', () => {
    const pk = [{ package_id: U(1), job_id: J, name: 'Division 26 — Electrical', csi_division: '26', status: 'OPEN', sort: 26, lead_time_days: 30, budget_cents: 4_000_000, committed_cents: 0, need_by: '2026-10-20', days_to_need: -5 }];
    const html = wrap(<BuyoutView packages={pk} today={TODAY} canEdit onSeed={() => {}} />);
    expect(html).toContain('5 days late');
    expect(html).toContain('40,000');
    const masked = wrap(<BuyoutView packages={pk} today={TODAY} canEdit={false} />, NO_MONEY);
    expect(masked).not.toContain('40,000');
    expect(masked).toContain('Division 26');
  });

  it('job cost drill-down', () => {
    const rows: CostDetailRow[] = [{ id: U(1), occurred_on: '2026-10-03', cost_code_id: U(10), cost_code: '26-100', cost_type: 'LABOR', amount_cents: 1_840_000, lifecycle: 'CLEARED', gate: 'TIMESHEET_PAYROLL', source_ref: 'PR-2026-40', gl_entry_id: null, vendor_id: null, description: 'Payroll week 40', commitment_line_id: null, commitment_number: null }];
    const html = wrap(<CostDetailView jobId={J} jobs={[job]} rows={rows} codes={[{ id: U(10), code: '26-100', name: 'Branch wiring' }]} commitments={[{ commitment_id: U(3), number: 'SC-0001', vendor_name: 'Sparky', committed: 500_000, invoiced: 200_000, paid: 150_000, open: 300_000 }]} vendors={{}} from={null} to={null} today={TODAY} booksPresent />);
    expect(html).toContain('26-100 Branch wiring');
    expect(html).toContain('18,400.00');
    expect(html).toContain('Committed, invoiced and paid');
    expect(wrap(<CostDetailView jobId={null} jobs={[job]} rows={[]} codes={[]} commitments={[]} vendors={{}} from={null} to={null} today={TODAY} booksPresent />)).toContain('Pick a job');
  });

  it('billing calendar', () => {
    const rows: Array<CalendarRow & { location_id: string }> = [{ job_id: J, location_id: A, job_number: '26-0533', job_name: 'Mercy West', customer_name: 'Turner', billing_form: 'TEXTURA', billing_portal_url: null, billing_cutoff_day: 25, next_cutoff: '2026-10-25', pencil_due: '2026-10-20', current_status: null, current_stage: 'PENCIL', portal_status: null, retainage_outstanding_cents: 75_000 }];
    const html = wrap(<BillingCalendarView rows={rows} billed={{ [J]: { billed: 400_000, last: '2026-09-30' } }} today={TODAY} />);
    expect(html).toContain('Cutoff · 26-0533');
    expect(html).toContain('Pencil · 26-0533');
  });

  it('monthly review package with commentary to pre-write', () => {
    const pkg: ReviewPackage = {
      id: U(1), job_id: J, location_id: A, period_end: '2026-09-30', status: 'DRAFT', pm_commentary: null, built_at: '2026-10-02T12:00:00Z', submitted_at: null, signed_at: null, submitted_by: null, signed_by: null,
      content: { financials: { revised_contract_cents: 1_500_000, revised_budget_cents: 1_200_000, committed_cents: 900_000, actual_cost_cents: 600_000, projected_final_cost_cents: 1_250_000, projected_margin_cents: 250_000 },
        eac: { status: 'APPROVED', total_eac_cents: 1_250_000, prior_eac_cents: 1_200_000 }, change_orders: [{ number: 'CO-004', title: 'Feeders', stage: 'APPROVED', amount_cents: 100_000, cost_impact_cents: 80_000, approved_at: null }],
        schedule: { tasks: 40, done: 22, late: 3 }, documents: { rfis_open: 4, rfis_overdue: 1, submittals_open: 2, submittals_late: 0 }, safety: { incidents: 0, recordables: 0 } },
    };
    const html = wrap(<ReviewPackageView packages={[pkg]} jobs={[job]} periods={['2026-10-31', '2026-09-30']} jobId={J} periodEnd="2026-09-30" today={TODAY} canBuild />);
    for (const s of ['Job cost', 'Cost forecast', 'CO-004', 'Pre-write from the figures', 'Submit for sign-off']) expect(html, s).toContain(s);
  });
});

describe('document control and directory', () => {
  it('directory with trade data', () => {
    const e: DirectoryEntry = { job_id: J, directory_id: U(1), party_role: 'SUBCONTRACTOR', vendor_id: V, customer_id: null, contact_id: null, company_name: 'Sparky Electric', contact_name: 'Dana Ruiz', email: 'dana@sparky.test', phone: null, trade: 'Electrical', csi_divisions: ['26'], distribution_groups: ['subs'], is_primary: true, union_local: 'IBEW 347', dbe: true, mbe: false, wbe: false, emr: 0.82, licenses: [], prequal_status: 'QUALIFIED', prequal_expires: '2027-03-01' };
    const html = wrap(<DirectoryView entries={[e]} profiles={[]} vendors={[{ id: V, name: 'Sparky Electric' }]} jobs={[job]} today={TODAY} canEdit canEditProfiles />);
    for (const s of ['Sparky Electric', 'DBE', 'IBEW 347', '0.82', 'Qualified', 'Email 1']) expect(html, s).toContain(s);
  });

  it('project templates with the global-update count', () => {
    const t: ProjectTemplate = { id: U(1), location_id: A, key: 'ground_up', name: 'Ground-up construction', kind: 'GROUND_UP', description: 'New building', version: 3, payload: { contract_settings: { change_tiers: 3 } }, is_active: true, updated_at: '2026-10-01T00:00:00Z' };
    const html = wrap(<TemplatesView templates={[t]} applications={[{ job_id: J, template_id: U(1), version: 2, applied_at: '' }]} jobs={[job]} companies={[{ id: A, name: 'Heartland' }]} canConfigure canApply />);
    expect(html).toContain('1 to update');
    expect(wrap(<TemplatesView templates={[]} applications={[]} jobs={[job]} companies={[{ id: A, name: 'Heartland' }]} canConfigure canApply />)).toContain('Add the standard templates');
  });

  it('trade proposals', () => {
    const p: TradeProposal = { id: U(1), location_id: A, customer_id: U(77), number: 'PR-HL-2026-004', project_name: 'Mercy West — electrical', base_bid_cents: 48_500_000, alternates: [{ label: 'LED upgrade', amount_cents: 1_200_000 }], unit_prices: [], inclusions: [], exclusions: ['Utility charges'], qualifications: [], schedule_assumptions: null, valid_until: '2026-10-28', status: 'SENT', sent_at: '2026-09-28T00:00:00Z', accepted_at: null, job_id: null, created_at: '2026-09-20T00:00:00Z' };
    const html = wrap(<TradeProposalsView proposals={[p]} customers={[{ id: U(77), name: 'Turner' }]} companies={[{ id: A, name: 'Heartland' }]} jobTypes={[]} today={TODAY} canEdit canAccept />);
    expect(html).toContain('PR-HL-2026-004');
    expect(html).toContain('485,000');
    expect(html).toContain('Expiring');
    expect(wrap(<TradeProposalsView proposals={[p]} customers={[]} companies={[]} jobTypes={[]} today={TODAY} canEdit={false} canAccept={false} />, NO_MONEY)).not.toContain('485,000');
  });

  it('specifications', () => {
    const s: SpecSection = { id: U(1), job_id: J, number: '26 05 19', title: 'Low-voltage conductors', division: '26', revision: 1, addendum: 'Addendum 2', document_id: null, page_start: 412, page_end: 420, updated_at: '2026-10-01T00:00:00Z' };
    const html = wrap(<SpecsView sections={[s]} submittalsBySection={{ [`${J}|26 05 19`]: 3 }} jobs={[job]} today={TODAY} canEdit />);
    for (const x of ['26 05 19', 'Electrical', 'Rev 1', 'Addendum 2', '412–420']) expect(html, x).toContain(x);
  });

  it('correspondence and transmittals', () => {
    const l: Correspondence = { id: U(1), job_id: J, corr_type: 'NOTICE_OF_DELAY', number: 'NOD-001', direction: 'OUTGOING', subject: 'Late steel', body: null, from_name: 'Mike', to_name: 'Pat', to_company: 'Owner LLC', sent_on: '2026-10-10', response_required_by: '2026-10-20', responded_on: null, status: 'SENT', change_event_id: null, created_at: '2026-10-10T00:00:00Z' };
    const t: Transmittal = { id: U(2), job_id: J, number: 'TR-001', subject: 'Shop drawings rev 2', to_name: 'HGA', to_company: null, to_email: null, purpose: 'FOR_APPROVAL', items: [{ description: 'S-1 to S-14', copies: 1 }], notes: null, status: 'SENT', sent_at: '2026-10-01T00:00:00Z', acknowledged_at: null, acknowledged_by: null, created_at: '2026-10-01T00:00:00Z' };
    const html = wrap(<CorrespondenceView transmittals={[t]} letters={[l]} jobs={[job]} today={TODAY} canEdit />);
    expect(html).toContain('NOD-001');
    expect(html).toContain('5 days late');
    expect(html).toContain('1 responses overdue');
  });
});

describe('field: quality, safety, productivity, crews', () => {
  it('inspections and observations', () => {
    const i: Inspection = { id: U(1), job_id: J, template_id: U(9), number: 'INS-004', title: 'Above-ceiling L2', category: 'ABOVE_CEILING', area: 'Level 2', inspected_on: '2026-10-24', inspector_name: 'Ann Lee', status: 'COMPLETE', result: 'PARTIAL', signed_by_name: 'Ann Lee', signed_at: '2026-10-24T20:00:00Z' };
    expect(wrap(<InspectionsView inspections={[i]} templates={[{ id: U(9), name: 'Above-ceiling', category: 'ABOVE_CEILING' }]} jobs={[job]} today={TODAY} canEdit />)).toContain('Start an inspection');
    const o: Observation = { id: U(2), job_id: J, number: 'OBS-012', obs_type: 'SAFETY', priority: 'HIGH', title: 'Unprotected edge at stair 2', description: null, hazard: 'Fall', contributing_condition: null, assignee_vendor_id: null, assignee_name: 'Super', due_on: '2026-10-22', status: 'OPEN', closed_at: null, inspection_item_id: null, created_at: '2026-10-20T00:00:00Z' };
    const html = wrap(<ObservationsView observations={[o]} jobs={[job]} vendors={[]} today={TODAY} canEdit canChange />);
    expect(html).toContain('OBS-012');
    expect(html).toContain('1 past due');
  });

  it('safety with incidents, and without injury access the incident tabs are gone', () => {
    const talk: ToolboxTalk = { id: U(1), job_id: J, held_on: '2026-10-20', topic: 'Ladder setup', language: 'es', presenter_name: 'Luis', notes: null, attendees: 12 };
    const jha: Jha = { id: U(2), job_id: J, work_date: TODAY, task_description: 'Pull feeders', area: 'Shaft', steps: [{ step: 'Set up puller', hazard: 'Pinch', control: 'Guard' }], ppe: ['Gloves'], permits: [], status: 'DRAFT', signoffs: [] };
    const inc: Incident = { id: U(3), job_id: J, number: '2026-001', incident_type: 'INJURY', occurred_at: '2026-10-15T14:00:00Z', reported_at: '2026-10-15T15:00:00Z', person_name: 'Bo', job_title: 'Apprentice', company: null, is_employee: true, description: 'Cut hand', where_occurred: 'L3', body_part: 'Hand', injury_nature: 'Laceration', object_substance: null, witnesses: [], root_cause: null, corrective_actions: [], osha_recordable: null, osha_classification: null, injury_or_illness: 'INJURY', days_away: 0, days_restricted: 0, privacy_case: false, case_number: null, wc_claim_ref: null, status: 'OPEN' };
    const html = wrap(<SafetyView talks={[talk]} jhas={[jha]} incidents={[inc]} incidentsVisible hazards={['Open edge']} jobs={[job]} companies={[{ id: A, name: 'Heartland' }]} today={TODAY} canRecord canIncident />);
    expect(html).toContain('Ladder setup');
    expect(html).toContain('Español');
    expect(html).toContain('OSHA logs');
    expect(wrap(<SafetyView talks={[]} jhas={[jha]} incidents={[inc]} incidentsVisible hazards={[]} jobs={[job]} companies={[]} today={TODAY} canRecord canIncident initialTab="incidents" />)).toContain('To determine');
    const noInjury = wrap(<SafetyView talks={[talk]} jhas={[]} incidents={[]} incidentsVisible={false} hazards={[]} jobs={[job]} companies={[]} today={TODAY} canRecord canIncident={false} />);
    expect(noInjury).not.toContain('OSHA logs');
  });

  it('productivity with a fading cost code', () => {
    const row = { cost_code_id: U(10), cost_code: '26-100', cost_code_name: 'Branch wiring', uom: 'LF', budget_qty: 10_000, budget_hours: 800, unit_hours: 0.08, installed_qty: 4_000, pct_complete: 0.4, earned_hours: 320, actual_hours: 480, productivity_factor: 0.6667, pct_hours_used: 0.6, projected_hours: 1200, variance_hours: 400 };
    const html = wrap(<ProductivityView jobId={J} data={{ rows: [row], units: [{ id: U(11), job_id: J, cost_code_id: U(10), budget_qty: 10_000, uom: 'LF', budget_hours: 800, unit_hours: null, pct_complete_entry: false }], codes: [{ id: U(10), code: '26-100', name: 'Branch wiring' }], quantities: [], alerts: [{ id: U(12), job_id: J, cost_code_id: U(10), week_start: '2026-10-12', budget_hours: 800, earned_hours: 320, actual_hours: 480, week_earned_hours: 40, week_actual_hours: 80, productivity_factor: 0.67, pct_hours_used: 0.6, pct_complete: 0.4, projected_hours: 1200, severity: 'CRITICAL', cause_hint: 'overtime 30% of the week’s hours', status: 'OPEN' }] }} today={TODAY} canLog canSetUnits canFade />);
    for (const s of ['0.67', 'Critical', 'overtime 30%', 'Installed today (LF)', 'Budget units and hours']) expect(html, s).toContain(s);
  });

  it('workforce board with a double booking and the bench', () => {
    const html = wrap(<WorkforceView companyId={A} companies={[{ id: A, name: 'Heartland' }]} from="2026-10-19" weeks={['2026-10-19', '2026-10-26']}
      requests={[{ id: U(1), job_id: J, role: 'JOURNEYMAN', headcount: 2, start_week: '2026-10-19', end_week: '2026-10-26', status: 'OPEN', trade: 'Electrician' }]}
      assignments={[{ id: U(2), job_id: J, employee_id: U(5), request_id: null, role: 'FOREMAN', week_start: '2026-10-19', days: 6, per_diem: true, travel: false, status: 'CONFIRMED' }]}
      conflicts={[{ week_start: '2026-10-19', employee_id: U(5), job_id: null, conflict: 'DOUBLE_BOOKED', detail: '6 days booked across 1 jobs' }]}
      employees={[{ id: U(5), name: 'Ann Lee', title: 'Foreman' }, { id: U(6), name: 'Cy Park', title: 'Journeyman' }]} jobs={[job]} today={TODAY} canAssign canRequest />);
    for (const s of ['Ann Lee', '26-0533 · 6d · firm · PD', 'On the bench', '2 × Journeyman · Electrician']) expect(html, s).toContain(s);
  });

  it('foreman daily plan', () => {
    const plan: ForemanPlan = { date: TODAY, crew: [{ employee_id: U(5), role: 'FOREMAN', name: 'Ann Lee' }], tasks: [{ id: U(1), title: 'Pull feeders L3', status: 'IN_PROGRESS', start_on: TODAY, due_on: '2026-10-28', cost_code_id: null, pct_complete: 40 }],
      deliveries: [{ title: 'Switchgear', number: 'SUB-014', status: 'SHIPPED', delivered_on: null, ship_on: TODAY }], jha: [], hazards: [{ id: U(2), number: 'OBS-012', title: 'Open edge', priority: 'HIGH' }], sheets: [{ id: U(3), sheet_number: 'E-301', title: 'Level 3 power' }],
      yesterday: [{ cost_code: '26-100', earned_hours: 30, actual_hours: 40, productivity_factor: 0.75, pct_complete: 0.4 }] };
    const html = wrap(<ForemanPlanView jobs={[job]} jobId={J} date={TODAY} plan={plan} codes={[{ id: U(10), code: '26-100', name: 'Branch wiring' }]} units={[]} today={TODAY} canLog error={null} />);
    for (const s of ['Ann Lee', 'Pull feeders L3', 'Switchgear', 'No pre-task plan for today', 'E-301', '0.75', 'Installed today']) expect(html, s).toContain(s);
  });

  it('closeout board, and the job closeout loading', () => {
    const item: CloseoutItem = { id: U(1), job_id: J, category: 'FINAL_LIEN_WAIVER', title: 'Final lien waiver — Sparky', form_ref: null, commitment_id: null, vendor_id: V, spec_section: null, required: true, status: 'REQUESTED', due_on: '2026-10-01', document_id: null, warranty_starts_on: null, warranty_years: null, warranty_ends_on: null, accepted_at: null, notes: null };
    const html = wrap(<CloseoutBoard jobs={[job]} items={[item]} jobId={null} today={TODAY} canEdit canClose />);
    expect(html).toContain('0 of 1');
    expect(wrap(<CloseoutJob jobId={J} today={TODAY} canEdit canClose />)).toContain('Loading the closeout');
  });

  it('the job page tab bodies render their loading states', () => {
    expect(wrap(<ProductivityTab jobId={J} />)).toContain('Loading productivity');
    expect(wrap(<BuyoutTab jobId={J} canSeed />)).toContain('Loading the buyout log');
    expect(wrap(<CloseoutTab jobId={J} canEdit />)).toContain('Loading the closeout');
    expect(wrap(<SafetyTab jobId={J} />)).toContain('Inspections');
  });
});

describe('empty states say what to do', () => {
  it('each list screen', () => {
    expect(wrap(<PayAppsView rows={[]} jobs={[job]} draftable={[]} today={TODAY} />)).toContain('Draft the pencil from the job');
    expect(wrap(<SpecsView sections={[]} submittalsBySection={{}} jobs={[job]} today={TODAY} canEdit />)).toContain('table of contents');
    expect(wrap(<ObservationsView observations={[]} jobs={[job]} vendors={[]} today={TODAY} canEdit canChange />)).toContain('No open observations');
    expect(wrap(<InspectionsView inspections={[]} templates={[]} jobs={[job]} today={TODAY} canEdit />)).toContain('No inspections in progress');
    expect(wrap(<BillingCalendarView rows={[]} billed={{}} today={TODAY} />)).toContain('No jobs on the calendar');
    expect(wrap(<ReviewPackageView packages={[]} jobs={[job]} periods={['2026-09-30']} jobId={null} periodEnd="2026-09-30" today={TODAY} canBuild />)).toContain('No packages for 2026-09 yet');
    expect(wrap(<DirectoryView entries={[]} profiles={[]} vendors={[]} jobs={[job]} today={TODAY} canEdit canEditProfiles />, ALL_MONEY, true)).not.toContain('Add to directory');
  });
});
