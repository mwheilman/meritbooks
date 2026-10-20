/**
 * SSR smoke test for the money views with real-shaped rows (the 1102 harness job: contract
 * 100,000,000 at 10% retention, two SOV lines, app #1 issued, app #2 drafted). merit-ui asserts
 * that statement totals tie in development, so a mis-tied G702 / G703 / job cost table throws here.
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
import { EstimateTab } from '@/components/money/EstimateTab';
import { CommitmentsTab } from '@/components/money/CommitmentsTab';
import { BillingTab } from '@/components/money/BillingTab';
import { JobCostTab, costStatement, refreshToast } from '@/components/money/JobCostTab';
import { BillingQueue, type BillingQueueRowView } from '@/components/money/BillingQueue';
import { CommitmentQueue } from '@/components/money/CommitmentQueue';
import { EstimatesList } from '@/components/money/EstimatesList';
import { SubcontractorsView } from '@/components/money/SubcontractorsView';
import { RetainageView } from '@/components/money/RetainageView';
import { JobCostView } from '@/components/money/JobCostView';
import { G702Table, G703Table } from '@/components/money/PayApp';
import { SeamHealthWidget, seamSummary } from '@/components/home/SeamHealthWidget';
import { billingModesFor } from '@/lib/pm/money/billing-modes';
import { g702, g703Line } from '@/lib/pm/money/aia';
import type { BillingBundle } from '@/lib/pm/money/queries';
import type {
  BillingLineRow, BillingRequestRow, CommitmentLineRow, CommitmentRow, CommitmentStatusRow, ComplianceDocRow, CostCodeStatusRow, EstimateLineRow, EstimateRow,
  JobFinancialsRow, SeamHealthRow, SovLineRow, SovVersionRow,
} from '@/lib/pm/money/types';
import type { CostCodeRow } from '@/lib/pm/types';

const J = '0bf579d0-7e25-421c-956c-4f1be58fa640';
const L = 'aaaaaaaa-0000-4000-8000-00000000000a';

function wrap(el: ReactElement, readOnly = false): string {
  return renderToString(
    <MeritProvider>
      <ShellProvider value={{ vocab: { ...DEFAULT_VOCAB }, companies: [], activeCompanyId: L, readOnly, setCrumbs: () => {} }}>{el}</ShellProvider>
    </MeritProvider>,
  );
}

const codes: CostCodeRow[] = [
  { id: 'cc12', location_id: L, job_id: null, parent_id: null, code: '12', name: 'Casework & interiors', cost_type: 'MATERIALS', role_hint: null, install_id: null, source_pack: null, sort: 0, is_active: true },
  { id: 'cc15', location_id: L, job_id: null, parent_id: null, code: '15', name: 'Plumbing', cost_type: 'SUBCONTRACTOR', role_hint: 'SUBCONTRACT_COST', install_id: null, source_pack: null, sort: 1, is_active: true },
];

// ---------------------------------------------------------------------------
const est = (o: Partial<EstimateRow>): EstimateRow => ({
  id: 'e1', location_id: L, job_id: J, customer_id: null, number: 'EST-ACM-2026-0001', version: 1, title: 'Ankeny Middle School', status: 'DRAFT', retainage_pct: 0.1,
  valid_until: '2026-11-30', notes: null, total_cents: 100_000_000, cost_total_cents: 70_000_000, supersedes_id: null, budget_id: null, sent_at: null, accepted_at: null,
  accepted_by: null, declined_at: null, decline_reason: null, created_by: 'u1', created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z', ...o,
});
const eline = (o: Partial<EstimateLineRow>): EstimateLineRow => ({
  id: 'el1', estimate_id: 'e1', line_no: 1, cost_code_id: 'cc12', description: 'Casework', qty: 12.5, uom: 'ea', unit_cost_cents: 1999, unit_price_cents: 2399,
  cost_cents: 24_988, amount_cents: 29_988, is_allowance: false, sort: 0, ext: { markup_pct: 0.2 }, ...o,
});

describe('estimate tab', () => {
  it('empty, draft with the line editor, and accepted with links to the budget and contract', () => {
    expect(wrap(<EstimateTab jobId={J} estimates={[]} lines={[]} costCodes={codes} contractCents={0} budgetCents={null} booksPresent />)).toContain('Price this job');
    const draft = wrap(<EstimateTab jobId={J} estimates={[est({})]} lines={[eline({}), eline({ id: 'el2', line_no: 2, qty: null, unit_cost_cents: null, unit_price_cents: null, cost_cents: 5000, amount_cents: 5000, is_allowance: true, cost_code_id: null })]} costCodes={codes} contractCents={0} budgetCents={null} booksPresent />);
    expect(draft).toContain('Add line');
    expect(draft).toContain('Accepted');
    expect(draft).toContain('1 costed line has no cost code');
    const accepted = wrap(<EstimateTab jobId={J} estimates={[est({ id: 'e2', version: 2, status: 'ACCEPTED', accepted_at: '2026-10-05T12:00:00Z', budget_id: 'b1' }), est({ status: 'SUPERSEDED' })]} lines={[eline({ estimate_id: 'e2' })]} costCodes={codes} contractCents={100_000_000} budgetCents={70_000_000} booksPresent />);
    expect(accepted).toContain('Open the budget');
    expect(accepted).toContain(`/jobs/${J}?tab=contract`);
    expect(accepted).not.toContain('Add line');
  });
});

// ---------------------------------------------------------------------------
const cmt = (o: Partial<CommitmentRow>): CommitmentRow => ({
  id: 'c1', location_id: L, job_id: J, vendor_id: 'v1', commitment_type: 'SUBCONTRACT', number: 'SC-ACM-2026-0001', title: 'Plumbing subcontract', description: null, status: 'APPROVED',
  retainage_pct: 0.1, payment_hold: false, hold_reason: null, version: 2, executed_on: null, approved_by: 'u2', approved_at: '2026-10-02T12:00:00Z', approval: null, event_id: 'ev',
  last_emitted_hold: false, suppressed_reason: null, void_reason: null, created_by: 'u1', created_at: '2026-10-01T12:00:00Z', ...o,
});
const cline: CommitmentLineRow = { id: 'cl1', commitment_id: 'c1', line_no: 1, cost_code_id: 'cc15', cost_type: 'SUBCONTRACTOR', description: 'Plumbing rough + finish', qty: null, uom: null, unit_cost_cents: null, amount_cents: 22_000_000, original_amount_cents: 21_000_000, received_qty: 0, received_cents: 10_000_000, billed_cents: 8_000_000 };
const cstat: CommitmentStatusRow = {
  org_id: 'o', job_id: J, location_id: L, commitment_id: 'c1', number: 'SC-ACM-2026-0001', commitment_type: 'SUBCONTRACT', vendor_id: 'v1', vendor_name: 'Des Moines Plumbing', status: 'APPROVED', version: 2,
  retainage_pct: 0.1, manual_hold: false, hold_reason: null, compliance_ok: false, payment_hold_effective: true, commitment_line_id: 'cl1', line_no: 1, cost_code_id: 'cc15', cost_code: '15',
  cost_type: 'SUBCONTRACTOR', description: 'Plumbing rough + finish', original_amount_cents: 21_000_000, approved_change_cents: 1_000_000, revised_amount_cents: 22_000_000, billed_cents: 8_000_000,
  open_cents: 14_000_000, over_billed_cents: 0, qty: null, uom: null, unit_cost_cents: null, received_qty: 0, received_cents: 10_000_000, received_not_billed_cents: 2_000_000, pct_billed: 0.3636,
};
const coi: ComplianceDocRow = { id: 'd1', job_id: J, commitment_id: 'c1', vendor_id: 'v1', doc_type: 'COI', status: 'RECEIVED', required: true, expires_on: '2027-01-31', covers_through: null, amount_cents: null, notes: null, verified_by: null, verified_at: null, created_at: '2026-10-01T12:00:00Z' };

describe('commitments', () => {
  const props = {
    jobId: J, lines: [cline], status: [cstat], receipts: [], compliance: [coi], vendors: { v1: 'Des Moines Plumbing' }, costCodes: codes, ownerCos: [],
    currentUserId: 'u1', booksPresent: true, today: '2026-10-20', budgetByCode: { cc15: 20_000_000 },
    changes: [{ id: 'x1', job_id: J, commitment_id: 'c1', number: 'SC-ACM-2026-0001-CCO01', commitment_line_id: 'cl1', cost_code_id: null, description: 'Two floor drains', reason: null, amount_cents: 1_000_000, owner_co_id: null, status: 'APPROVED' as const, applied_line_id: 'cl1', approved_by: 'u2', approved_at: '2026-10-03T12:00:00Z', reject_reason: null, created_by: 'u1', created_at: '2026-10-03T12:00:00Z' }],
  };
  it('job tab: list with committed / received / billed / open, detail with the hold explained', () => {
    const html = wrap(<CommitmentsTab {...props} commitments={[cmt({})]} />);
    expect(html).toContain('Des Moines Plumbing');
    expect(html).toContain('On payment hold');
    expect(html).toContain('220,000.00'); // committed (revised)
    expect(html).toContain('140,000.00'); // open
    expect(html).toContain('tells Merit Books not to pay');
    expect(html).toContain('Held for compliance');
    expect(wrap(<CommitmentsTab {...props} commitments={[]} status={[]} lines={[]} />)).toContain('No commitments on this job yet');
  });
  it('a draft I prepared says someone else approves it', () => {
    const html = wrap(<CommitmentsTab {...props} commitments={[cmt({ status: 'DRAFT', approved_at: null, approved_by: null })]} status={[{ ...cstat, status: 'DRAFT', payment_hold_effective: false }]} changes={[]} />);
    expect(html).toContain('You prepared this one');
  });
  it('company queue and review mode', () => {
    const row = { id: 'c1', number: 'SC-ACM-2026-0001', type: 'SUBCONTRACT' as const, title: 'Plumbing', status: 'DRAFT' as const, vendorName: 'Des Moines Plumbing', jobId: J, jobLabel: 'ACM-2026-0001 · Ankeny', company: null, retainagePct: 0.1, createdBy: 'u1', approvedAt: null, holdReason: null,
      t: { committed: 21_000_000, original: 21_000_000, changes: 0, received: 0, billed: 0, open: 0, overBilled: 0, receivedNotBilled: 0, lines: 1, vendorName: 'Des Moines Plumbing', holdEffective: false, complianceOk: true } };
    expect(wrap(<CommitmentQueue rows={[row]} currentUserId="u2" showCompany={false} />)).toContain('To approve');
    expect(wrap(<CommitmentQueue rows={[]} currentUserId="u2" showCompany={false} mode="review" />)).toContain('No commitments are waiting for approval');
  });
});

// ---------------------------------------------------------------------------
const version: SovVersionRow = { id: 'sv1', job_id: J, contract_id: 'k1', version: 1, status: 'ACTIVE', retainage_pct: null, memo: null, activated_at: '2026-09-01T12:00:00Z', created_at: '2026-09-01T12:00:00Z' };
const sovLines: SovLineRow[] = [
  { id: 's1', sov_version_id: 'sv1', lineage_id: 'L1', line_no: 1, cost_code_id: 'cc12', description: 'Casework & interiors', scheduled_value_cents: 60_000_000, retainage_pct: null, change_order_id: null, sort: 0 },
  { id: 's2', sov_version_id: 'sv1', lineage_id: 'L2', line_no: 2, cost_code_id: 'cc15', description: 'Plumbing', scheduled_value_cents: 40_000_000, retainage_pct: null, change_order_id: null, sort: 1 },
];
const req = (o: Partial<BillingRequestRow>): BillingRequestRow => ({
  id: 'r1', location_id: L, job_id: J, contract_id: 'k1', billing_type: 'PROGRESS', billing_subtype: 'SOV', status: 'ISSUED', generated_by: 'sov', application_no: 1, sov_version_id: 'sv1',
  period_start: null, period_end: '2026-09-30', occurred_on: '2026-09-30', memo: 'Application #1 for the period ending 2026-09-30', source_ref: 'pm:bill:r1', gross_earned_cents: 21_000_000,
  retainage_cents: 2_100_000, retainage_released_cents: 0, net_cents: 18_900_000, suppressed_reason: null, event_id: 'ev1', invoice_id: 'i1', invoice_number: 'INV-ACM-202610-0001',
  error_text: null, created_by: 'u1', approved_by: 'u2', approved_at: '2026-10-01T12:00:00Z', emitted_at: '2026-10-01T12:00:00Z', issued_at: '2026-10-01T13:00:00Z', void_reason: null, created_at: '2026-10-01T12:00:00Z', ...o,
});
const bl = (o: Partial<BillingLineRow>): BillingLineRow => ({
  id: 'bl1', billing_request_id: 'r1', line_no: 1, sort: 0, line_type: 'STANDARD', description: 'Casework & interiors', amount_cents: 15_000_000, cost_code_id: 'cc12', sov_line_id: 's1', sov_lineage_id: 'L1',
  task_id: null, wbs_id: null, allowance_id: null, scheduled_value_cents: 60_000_000, previous_work_cents: 0, this_period_work_cents: 15_000_000, stored_materials_cents: 0, previous_stored_cents: 0,
  total_completed_cents: 15_000_000, pct_complete: 0.25, balance_to_finish_cents: 45_000_000, retainage_rate: 0.1, retainage_work_to_date_cents: 1_500_000, retainage_stored_to_date_cents: 0,
  retainage_this_period_cents: 1_500_000, ...o,
});

function bundle(): BillingBundle {
  const r2 = req({ id: 'r2', status: 'DRAFT', application_no: 2, period_end: '2026-10-31', occurred_on: '2026-10-31', gross_earned_cents: 18_500_000, retainage_cents: 1_850_000, net_cents: 16_650_000, invoice_number: null, invoice_id: null, event_id: null, approved_at: null, emitted_at: null, issued_at: null, created_by: 'u1', created_at: '2026-10-20T12:00:00Z', memo: 'Application #2' });
  return {
    requests: [r2, req({})],
    lines: [
      bl({}),
      bl({ id: 'bl2', line_no: 2, sort: 1, description: 'Plumbing', amount_cents: 6_000_000, cost_code_id: 'cc15', sov_line_id: 's2', sov_lineage_id: 'L2', scheduled_value_cents: 40_000_000, this_period_work_cents: 4_000_000, stored_materials_cents: 2_000_000, total_completed_cents: 6_000_000, pct_complete: 0.15, balance_to_finish_cents: 34_000_000, retainage_work_to_date_cents: 400_000, retainage_stored_to_date_cents: 200_000, retainage_this_period_cents: 600_000 }),
      bl({ id: 'bl3', line_no: 9999, sort: 1_000_000, line_type: 'RETAINAGE', description: 'Retainage withheld (10%)', amount_cents: -2_100_000, cost_code_id: null, sov_line_id: null, sov_lineage_id: null, scheduled_value_cents: null, previous_work_cents: null, this_period_work_cents: null, stored_materials_cents: null, previous_stored_cents: null, total_completed_cents: null, pct_complete: null, balance_to_finish_cents: null, retainage_rate: null, retainage_work_to_date_cents: null, retainage_stored_to_date_cents: null, retainage_this_period_cents: 0 }),
      bl({ id: 'bl4', billing_request_id: 'r2', previous_work_cents: 15_000_000, total_completed_cents: 30_000_000, pct_complete: 0.5, balance_to_finish_cents: 30_000_000, retainage_work_to_date_cents: 3_000_000 }),
      bl({ id: 'bl5', billing_request_id: 'r2', line_no: 2, sort: 1, description: 'Plumbing', amount_cents: 3_500_000, cost_code_id: 'cc15', sov_line_id: 's2', sov_lineage_id: 'L2', scheduled_value_cents: 40_000_000, previous_work_cents: 4_000_000, this_period_work_cents: 5_000_000, stored_materials_cents: 500_000, previous_stored_cents: 2_000_000, total_completed_cents: 9_500_000, pct_complete: 0.2375, balance_to_finish_cents: 30_500_000, retainage_work_to_date_cents: 900_000, retainage_stored_to_date_cents: 50_000, retainage_this_period_cents: 350_000 }),
    ],
    queue: [{ kind: 'BILLING', id: 'r2', org_id: 'o', location_id: L, job_id: J, job_number: 'ACM-2026-0001', job_name: 'Ankeny', customer_name: 'Ankeny Schools', billing_type: 'PROGRESS', billing_subtype: 'SOV', status: 'DRAFT', application_no: 2, occurred_on: '2026-10-31', period_end: '2026-10-31', gross_earned_cents: 18_500_000, retainage_cents: 1_850_000, retainage_released_cents: 0, net_cents: 16_650_000, created_by: 'u1', created_at: '2026-10-20T12:00:00Z', approved_by: null, emitted_at: null, error_text: null, age_days: 0, failing_preconditions: [], next_action: 'APPROVE' }],
    payApps: [
      { org_id: 'o', job_id: J, billing_request_id: 'r2', application_no: 2, period_end: '2026-10-31', status: 'DRAFT', sov_version_id: 'sv1', original_contract_cents: 100_000_000, net_change_by_co_cents: 0, contract_sum_to_date_cents: 100_000_000, total_completed_stored_cents: 39_500_000, retainage_work_cents: 3_900_000, retainage_stored_cents: 50_000, retainage_total_cents: 3_950_000, total_earned_less_retainage_cents: 35_550_000, previous_certificates_cents: 18_900_000, current_payment_due_cents: 16_650_000, balance_to_finish_incl_retainage_cents: 64_450_000, request_net_cents: 16_650_000 },
    ],
    sovVersions: [version], sovLines, sovStatus: sovLines.map((s, i) => ({ org_id: 'o', job_id: J, sov_version_id: 'sv1', sov_version: 1, sov_status: 'ACTIVE' as const, sov_line_id: s.id, lineage_id: s.lineage_id, line_no: s.line_no, description: s.description, cost_code_id: s.cost_code_id, scheduled_value_cents: s.scheduled_value_cents, work_completed_cents: i ? 4_000_000 : 15_000_000, stored_materials_cents: i ? 2_000_000 : 0, completed_and_stored_cents: i ? 6_000_000 : 15_000_000, pct_complete: i ? 0.15 : 0.25, balance_to_finish_cents: i ? 34_000_000 : 45_000_000, retainage_held_cents: i ? 600_000 : 1_500_000, retainage_released_cents: 0, retainage_outstanding_cents: i ? 600_000 : 1_500_000, last_application_no: 1 })),
    deposits: [{ id: 'd1', location_id: L, job_id: J, customer_id: 'cu', amount_cents: 5_000_000, memo: 'Mobilization deposit', occurred_on: '2026-09-05', status: 'ISSUED', suppressed_reason: null, source_ref: 'pm:deposit:d1', event_id: 'e', invoice_number: 'INV-ACM-202609-0001', error_text: null, emitted_at: '2026-09-05T12:00:00Z', issued_at: '2026-09-05T13:00:00Z', created_by: 'u1', created_at: '2026-09-05T12:00:00Z' }],
    allowances: [], tasks: [], wbs: [],
    retainage: { org_id: 'o', job_id: J, held_cents: 2_100_000, released_cents: 0, outstanding_cents: 2_100_000 },
    financials: null,
  };
}

describe('billing tab', () => {
  const base = {
    jobId: J, contract: { id: 'k1', kind: 'PRIME', original_cents: 100_000_000, retention_pct: 0.1, retention_cap_cents: null, pct_complete: null, billing_mode: 'SOV' },
    revisedContractCents: 100_000_000, costCodes: codes, currentUserId: 'u1', booksPresent: true, isSample: false, today: '2026-10-20', hasAcceptedEstimate: true, coStage: {},
  };
  it('pay application mode: active SOV, the draft #2 with its G703 and G702, and the Merit Books note', () => {
    const html = wrap(<BillingTab {...base} bundle={bundle()} modes={billingModesFor({ billingModes: ['SOV', 'PROGRESS_PCT', 'DEPOSIT'], defaultBillingMode: 'SOV', modules: new Set(['billing', 'retainage']) })} initialRequestId="r2" />);
    expect(html).toContain('Merit Books numbers and posts the invoice');
    expect(html).toMatch(/Schedule of values v(<!-- -->)?1/);
    expect(html).toMatch(/Pay application #(<!-- -->)?2/);
    expect(html).toContain('AIA G702');
    expect(html).toContain('166,500.00'); // line 8 current payment due
    expect(html).toContain('644,500.00'); // line 9
    expect(html).toContain('You prepared this one');
    expect(html).toMatch(/All<span class="n">3/); // the issued app and the issued deposit sit under All
  });
  it('standalone: approved requests are kept here, not sent', () => {
    const b = bundle();
    b.requests = [req({ status: 'UNISSUED', suppressed_reason: 'STANDALONE', invoice_number: null, event_id: null })];
    const html = wrap(<BillingTab {...base} booksPresent={false} bundle={b} modes={billingModesFor({ billingModes: ['PROGRESS_PCT'], modules: new Set(['billing']) })} initialRequestId="r1" />);
    expect(html).toContain('Merit Books is not on for this workspace');
    expect(html).toContain('Approved, not sent');
    expect(html).toContain('Percent complete to date');
  });
  it('no billing mode: says where billing lives', () => {
    expect(wrap(<BillingTab {...base} bundle={{ ...bundle(), requests: [], lines: [], deposits: [], queue: [], payApps: [] }} modes={billingModesFor({ billingModes: ['DRAW'], modules: new Set() })} />)).toContain('Retainage release');
  });
  it('G703 / G702 tables tie on the harness numbers', () => {
    const l1 = g703Line({ scheduledCents: 60_000_000, rate: 0.1, prior: { previousWorkCents: 0, previousStoredCents: 0, previousRetainageCents: 0 }, entry: { pctComplete: 0.25 } });
    const l2 = g703Line({ scheduledCents: 40_000_000, rate: 0.1, prior: { previousWorkCents: 0, previousStoredCents: 0, previousRetainageCents: 0 }, entry: { pctComplete: 0.1, storedMaterialsCents: 2_000_000 } });
    const g703 = wrap(<G703Table rows={[{ id: 'a', item: 1, description: 'Casework', line: l1 }, { id: 'b', item: 2, description: 'Plumbing', line: l2 }]} />);
    expect(g703).toContain('210,000.00');
    const g = wrap(<G702Table s={g702([l1, l2], { originalContractCents: 100_000_000, previousCertificatesCents: 0, previousRetainageHeldCents: 0 })} applicationNo={1} />);
    expect(g).toContain('189,000.00');
    expect(g).toContain('811,000.00');
  });
});

// ---------------------------------------------------------------------------
const ccs = (o: Partial<CostCodeStatusRow>): CostCodeStatusRow => ({
  org_id: 'o', job_id: J, cost_code_id: 'cc15', cost_code: '15', cost_code_name: 'Plumbing', cost_type: 'SUBCONTRACTOR', budget_cents: 20_000_000, committed_cents: 22_000_000,
  committed_open_cents: 14_000_000, actual_cents: 8_000_000, pending_cents: 0, uncommitted_cost_cents: 0, forecast_cents: 22_000_000, variance_cents: -2_000_000, pct_spent: 0.4, ...o,
});
const fin: JobFinancialsRow = {
  org_id: 'o', job_id: J, location_id: L, job_number: 'ACM-2026-0001', job_name: 'Ankeny', original_contract_cents: 100_000_000, approved_co_cents: 0, revised_contract_cents: 100_000_000,
  pending_co_cents: 0, budget_original_cents: 70_000_000, revised_budget_cents: 70_000_000, committed_cents: 50_000_000, committed_open_cents: 32_000_000, actual_cost_cents: 21_500_000,
  pending_cost_cents: 0, forecast_by_cost_code_cents: 72_500_000, projected_final_cost_cents: 72_500_000, cost_to_complete_cents: 51_000_000, projected_margin_cents: 27_500_000,
  projected_margin_pct: 0.275, billed_to_date_cents: 39_500_000, billed_net_to_date_cents: 35_550_000, retainage_held_cents: 3_950_000, retainage_released_cents: 0,
  retainage_outstanding_cents: 3_950_000, deposits_requested_cents: 5_000_000, pct_complete_cost: 0.296552, earned_revenue_cents: 29_655_172, over_under_billing_cents: 9_844_828,
};

describe('job cost', () => {
  it('statement by cost type ties, header has the four numbers and over billing', () => {
    const rows = [ccs({}), ccs({ cost_code_id: 'cc12', cost_code: '12', cost_code_name: 'Casework', cost_type: 'MATERIALS', budget_cents: 50_000_000, committed_cents: 28_000_000, actual_cents: 13_500_000, forecast_cents: 50_500_000, variance_cents: -500_000 }), ccs({ cost_code_id: null, cost_code: null, cost_code_name: null, cost_type: null, budget_cents: 0, committed_cents: 0, actual_cents: 0, forecast_cents: 0, variance_cents: 0 })];
    expect(costStatement(rows).filter((r) => r.kind === 'sub')).toHaveLength(3);
    const html = wrap(<JobCostTab jobId={J} rows={rows} financials={fin} booksPresent />);
    expect(html).toContain('Actual from Merit Books');
    expect(html).toContain('Over billed');
    expect(html).toContain('Refresh from Merit Books');
    expect(html).toContain('27.5%');
    expect(wrap(<JobCostTab jobId={J} rows={[]} financials={null} booksPresent={false} />)).toContain('No cost by cost code yet');
  });
  it('refresh toast says what came in', () => {
    expect(refreshToast({ status: 'ok', applied: 2, stale: 1, duplicate: 1, rejected: 0 })).toEqual({ text: '2 costs from Merit Books applied · 1 out of order kept as history · 1 duplicate skipped', tone: 'ok' });
    expect(refreshToast({ status: 'busy' }).tone).toBe('neg');
    expect(refreshToast({ status: 'ok', applied: 0 }).text).toBe('No new costs from Merit Books');
  });
  it('company job cost sorts by fade', () => {
    const html = wrap(<JobCostView rows={[{ ...fin, label: 'ACM-2026-0001 · Ankeny', company: null }]} showCompany={false} />);
    expect(html).toContain('Worst fade first');
    expect(html).toContain('Projected margin');
  });
});

// ---------------------------------------------------------------------------
describe('company pages', () => {
  const q = (o: Partial<BillingQueueRowView>): BillingQueueRowView => ({ id: 'r2', kind: 'BILLING', band: 'ready', jobId: J, jobLabel: 'ACM-2026-0001 · Ankeny', company: null, customer: 'Ankeny Schools', label: 'Pay application #2', status: 'DRAFT', suppressed: null, date: '2026-10-31', gross: 18_500_000, retainage: 1_850_000, net: 16_650_000, invoice: null, error: null, failing: [], createdBy: 'u1', ageDays: 0, ...o });
  it('billing queue bands and the bulk approve verbs', () => {
    const html = wrap(<BillingQueue rows={[q({}), q({ id: 'r3', band: 'rejected', status: 'REJECTED', error: 'Customer has no billing address' }), q({ id: 'r1', band: 'issued', status: 'ISSUED', invoice: 'INV-ACM-202610-0001' })]} currentUserId="u1" booksPresent showCompany={false} />);
    expect(html).toContain('Ready to send');
    expect(html).toContain('Rejected');
    expect(html).toContain('You prepared it');
    expect(html).toContain('Check Merit Books now');
    expect(wrap(<BillingQueue rows={[]} currentUserId="u1" booksPresent showCompany={false} only={['ready', 'rejected']} label="Billing to send" />)).toContain('No billing to send waiting');
  });
  it('estimates by status, subcontractors, retainage', () => {
    expect(wrap(<EstimatesList rows={[{ id: 'e1', number: 'EST-ACM-2026-0001', version: 1, title: 'Ankeny', status: 'SENT', jobId: J, jobLabel: 'ACM-2026-0001', company: null, total: 100_000_000, cost: 70_000_000, date: '2026-10-01', validUntil: '2026-10-10' }]} today="2026-10-20" showCompany={false} />)).toContain('With the customer');
    const vendors = [{ id: 'v1', name: 'Des Moines Plumbing', commitments: [{ id: 'c1', number: 'SC-1', jobId: J, jobLabel: 'ACM', status: 'APPROVED', committed: 22_000_000, open: 14_000_000, billed: 8_000_000, held: true }], docs: [{ ...coi, jobLabel: 'ACM', commitmentNumber: 'SC-1' }] }];
    expect(wrap(<SubcontractorsView vendors={vendors} today="2026-10-20" />)).toContain('Needs documents');
    const ret = wrap(<RetainageView jobs={[{ jobId: J, jobLabel: 'ACM', company: null, held: 3_950_000, released: 0, outstanding: 3_950_000 }]} releases={[]} multi={false} booksPresent />);
    expect(ret).toContain('Retainage receivable');
    expect(ret).toContain('39,500.00');
  });
});

describe('seam health', () => {
  const row = (o: Partial<SeamHealthRow>): SeamHealthRow => ({ org_id: 'o', event_type: 'JOB_BILLING', pending_count: 0, processed_count: 4, rejected_count: 0, oldest_pending_at: null, oldest_pending_age_minutes: null, last_processed_at: null, alarm: 'OK', last_drain_at: null, ...o });
  it('summarises outbound waiting apart from inbound job cost; worst alarm wins', () => {
    const s = seamSummary([row({ pending_count: 2, oldest_pending_age_minutes: 4320, alarm: 'ALARM' }), row({ event_type: 'JOB_PROGRESS', pending_count: 1, oldest_pending_age_minutes: 90, alarm: 'WARN' }), row({ event_type: 'JOB_COST', pending_count: 5, alarm: 'OK' })]);
    expect(s).toMatchObject({ pending: 3, oldest: 4320, worst: 'ALARM' });
    expect(s.inbound?.pending_count).toBe(5);
  });
  it('renders its loading state first (it fetches /api/seam on the client)', () => {
    expect(wrap(<SeamHealthWidget />)).toContain('Checking Merit Books');
  });
});
