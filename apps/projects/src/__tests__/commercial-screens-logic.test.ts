/**
 * Wave C commercial screens — the pure logic behind them (lib/commercial/screen-logic.ts, the
 * route schemas, and the helpers the views export): spec parsing, G703 totals and edits, portal
 * export formats, retainage both sides, buyout, the billing calendar, OSHA, the workforce board,
 * job-cost drill-down, closeout, letters, review commentary.
 */
import { describe, expect, it } from 'vitest';
import {
  addDaysIso, awaitingResponse, csvCell, redactPrivacyCase, buyoutRisk, buyoutSummary, calendarState, checkLineEdits, closeoutBySub, costSource, divisionName, exportPayApp, groupCosts,
  letterDraft, lineEdits, mondayOf, monthGrid, oshaRate, parseSpecToc, payAppStep, payableReleaseState, receivableByCustomer, requestFill, sheetTotals,
  suggestRecordable, weekStarts, workforceGrid, GATE_FIX, type Assignment, type BuyoutPackage, type CostDetailRow, type RetainageBothRow, type SheetLine,
} from '@/lib/commercial/screen-logic';
import {
  CloseoutItemUpdate, DirectoryEntryCreate, IncidentUpdate, ProfileUpsert, ProposalCreate, QuantityCreate, SpecImport, TemplateUpdate, templateKey, toColumns,
} from '@/lib/commercial/screen-schemas';
import { defaultPeriodEnd } from '@/components/commercial/PayAppsView';
import { groupEmails } from '@/components/commercial/DirectoryView';
import { templateReach } from '@/components/commercial/TemplatesView';
import { proposalTotal } from '@/components/commercial/TradeProposalsView';
import { inspectionBlockers } from '@/components/commercial/InspectionsView';
import { repeatOffenders, sortObservations } from '@/components/commercial/ObservationsView';
import { suggestTopics } from '@/components/commercial/SafetyView';
import { productivityTotals } from '@/components/commercial/ProductivityView';
import { proposeFill } from '@/components/commercial/WorkforceView';
import { byGc } from '@/components/commercial/BillingCalendarView';
import { planCounts } from '@/components/commercial/ForemanPlanView';
import { draftCommentary } from '@/components/commercial/ReviewPackageView';
import type { DirectoryEntry, Observation } from '@/lib/commercial/screen-types';

const J = '00000000-0000-4000-8000-000000000001';
const J2 = '00000000-0000-4000-8000-000000000002';
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const line = (over: Partial<SheetLine> = {}): SheetLine => ({
  id: U(100), line_no: 1, description: 'Electrical rough-in', line_type: 'STANDARD', sov_line_id: U(200),
  scheduled_value_cents: 1_000_000, previous_work_cents: 400_000, this_period_work_cents: 200_000, stored_materials_cents: 50_000, previous_stored_cents: 0,
  total_completed_cents: 650_000, pct_complete: 0.65, balance_to_finish_cents: 350_000, retainage_rate: 0.1, retainage_work_to_date_cents: 60_000,
  retainage_stored_to_date_cents: 5_000, retainage_this_period_cents: 25_000, ...over,
});

describe('specifications (CGC-62)', () => {
  it('auto-sections a table of contents: MasterFormat normalized, own numbering kept, page numbers dropped, duplicates once', () => {
    const s = parseSpecToc([
      'SECTION 01 10 00 – SUMMARY',
      '092116  Gypsum Board Assemblies ........ 14',
      '09 21 16  Gypsum board (duplicate)',
      '26 05 19.13 Undercarpet cables',
      'Division 26 — Electrical',
      '15.1 Mechanical general provisions',
      'x',
    ].join('\n'));
    expect(s.map((x) => x.number)).toEqual(['01 10 00', '09 21 16', '26 05 19.13', '15.1']);
    expect(s[0]!.title).toBe('Summary');
    expect(s[1]).toMatchObject({ title: 'Gypsum Board Assemblies', division: '09', csi: true });
    expect(s[3]!.csi).toBe(false);
    expect(divisionName('26')).toBe('Electrical');
    expect(divisionName(null)).toBe('Other');
  });
});

describe('G703 continuation sheet and revisions (CGC-41)', () => {
  it('totals the standard lines only', () => {
    const t = sheetTotals([line(), line({ id: U(101), line_no: 2, scheduled_value_cents: 500_000, previous_work_cents: 0, this_period_work_cents: 100_000, stored_materials_cents: 0, total_completed_cents: 100_000, balance_to_finish_cents: 400_000, retainage_work_to_date_cents: 10_000, retainage_stored_to_date_cents: 0 }),
      line({ id: U(102), line_type: 'RETAINAGE_RELEASE', scheduled_value_cents: 999 })]);
    expect(t).toMatchObject({ scheduled: 1_500_000, previous: 400_000, thisPeriod: 300_000, stored: 50_000, completed: 750_000, balance: 750_000, retainage: 75_000 });
    expect(t.pct).toBeCloseTo(0.5);
  });

  it('sends only changed lines as work to date + stored, and refuses what the RPC would', () => {
    const l = line();
    expect(lineEdits([l], { [l.id]: { workToDate: 600_000, stored: 50_000 } })).toEqual([]);
    expect(lineEdits([l], { [l.id]: { workToDate: 700_000 } })).toEqual([{ sov_line_id: U(200), work_to_date_cents: 700_000, stored_materials_cents: 50_000 }]);
    expect(checkLineEdits([l], { [l.id]: { workToDate: 300_000 } })[0]!.problem).toMatch(/below what was billed/);
    expect(checkLineEdits([l], { [l.id]: { workToDate: 990_000, stored: 50_000 } })[0]!.problem).toMatch(/exceed the scheduled value/);
    expect(checkLineEdits([l], { [l.id]: { workToDate: 900_000, stored: 100_000 } })).toEqual([]);
  });

  it('stepper: returned pencils sit on "pencil sent", blocked', () => {
    expect(payAppStep('PENCIL')).toEqual({ index: 0, blocked: false });
    expect(payAppStep('REVISE')).toEqual({ index: 1, blocked: true });
    expect(payAppStep('FINAL').index).toBe(3);
    expect(payAppStep(null).index).toBe(0);
  });

  it('default period end follows the 25th cutoff', () => {
    expect(defaultPeriodEnd('2026-10-20')).toBe('2026-10-31');
    expect(defaultPeriodEnd('2026-10-27')).toBe('2026-11-30');
    expect(defaultPeriodEnd('2026-12-28')).toBe('2027-01-31');
  });
});

describe('portal export formats (CGC-43)', () => {
  const meta = { applicationNo: 7, periodEnd: '2026-10-31', jobLabel: '26-0533 Mercy West', revision: 2 };
  it('G703 layout has columns A–I and a totals row in dollars', () => {
    const out = exportPayApp('AIA_G703', [line()], meta);
    const rows = out.body.trim().split('\n');
    expect(out.fileName).toBe('26-0533-Mercy-West-app-7-r2-aia_g703.csv');
    expect(rows[2]).toMatch(/^A Item,B Description of work,C Scheduled value/);
    expect(rows[3]).toBe('1,Electrical rough-in,10000.00,4000.00,2000.00,500.00,6500.00,65.00,3500.00,650.00');
    expect(rows[4]).toMatch(/^,Totals,10000.00/);
  });
  it('Textura, GCPay, Procore Pay and the GC form each carry their own columns; commas are quoted', () => {
    const l = line({ description: 'Feeders, panels' });
    expect(exportPayApp('TEXTURA', [l], meta).body).toContain('1,"Feeders, panels",10000.00,4000.00,2000.00,500.00,65.00,650.00');
    expect(exportPayApp('GCPAY', [l], meta).body).toContain('Item,Description,Scheduled Value,Work This Period,Materials Stored,Retention');
    expect(exportPayApp('PROCORE_PAY', [l], meta).body).toContain('001,"Feeders, panels"');
    expect(exportPayApp('GC_FORM', [l], meta).body).toContain('"Feeders, panels",10000.00,65.00,2500.00');
  });
});

describe('CSV injection (security review L2)', () => {
  it('neutralizes formula-looking text with a leading apostrophe, keeps numbers numbers', () => {
    expect(['=HYPERLINK("x")', '+cmd', '-2+3', '@SUM(A1)', '\tTAB', '\rCR'].map(csvCell)).toEqual([`"'=HYPERLINK(""x"")"`, "'+cmd", "'-2+3", "'@SUM(A1)", "'\tTAB", `"'\rCR"`]);
    expect([csvCell('-2000.00'), csvCell(-5), csvCell('12.50'), csvCell('Plain, text'), csvCell(null)]).toEqual(['-2000.00', '-5', '12.50', '"Plain, text"', '']);
  });
  it('a hostile line description cannot reach a portal import as a formula', () => {
    const body = exportPayApp('TEXTURA', [line({ description: '=cmd|/c calc!A1' })], { applicationNo: 1, periodEnd: null, jobLabel: '=evil', revision: 1 }).body;
    expect(body).toContain("1,'=cmd|/c calc!A1,10000.00");
    expect(body.split('\n').some((r) => /(^|,)[=+@]/.test(r))).toBe(false);
  });
});

describe('OSHA privacy cases (security review L5)', () => {
  const inc = { privacy_case: true, person_name: 'Bo Diaz', job_title: 'Apprentice', description: 'Cut hand', body_part: 'Hand', injury_nature: 'Laceration', object_substance: 'Blade', witnesses: [{ name: 'A' }], wc_claim_ref: 'WC-9', id: 'x' };
  it('strips name and injury detail unless the caller manages safety; ordinary cases pass through', () => {
    expect(redactPrivacyCase(inc, false)).toMatchObject({ person_name: null, job_title: null, body_part: null, injury_nature: null, object_substance: null, witnesses: [], wc_claim_ref: null, id: 'x' });
    expect(redactPrivacyCase(inc, false).description).not.toContain('Cut hand');
    expect(redactPrivacyCase(inc, true)).toBe(inc);
    expect(redactPrivacyCase({ ...inc, privacy_case: false }, false).person_name).toBe('Bo Diaz');
  });
});

describe('retainage both sides (CGC-49)', () => {
  const r = (job: string, out: number, eligible: boolean): RetainageBothRow => ({
    job_id: job, location_id: U(9), receivable_held_cents: out + 1000, receivable_released_cents: 1000, receivable_outstanding_cents: out,
    payable_held_cents: 0, payable_released_cents: 0, payable_outstanding_cents: 0, substantial_completion_on: null, receivable_release_eligible: eligible,
  });
  it('groups receivable retainage by the owner or GC holding it, eligible amounts apart', () => {
    const g = receivableByCustomer([r(J, 50_000, true), r(J2, 20_000, false)], (id) => ({ id: 'gc1', name: id === J ? 'Turner' : 'Turner' }));
    expect(g).toEqual([{ key: 'gc1', label: 'Turner', jobs: 2, held: 72_000, released: 2_000, outstanding: 70_000, eligible: 50_000 }]);
  });
  it('a sub is released only with a verified final waiver', () => {
    expect(payableReleaseState({ held_cents: 100, outstanding_cents: 100, final_waiver_verified: false })).toBe('NEEDS_FINAL_WAIVER');
    expect(payableReleaseState({ held_cents: 100, outstanding_cents: 100, final_waiver_verified: true })).toBe('READY');
    expect(payableReleaseState({ held_cents: 100, outstanding_cents: 0, final_waiver_verified: true })).toBe('RELEASED');
    expect(payableReleaseState({ held_cents: 0, outstanding_cents: 0, final_waiver_verified: null })).toBe('NONE_HELD');
  });
});

describe('buyout (CGC-30)', () => {
  const p = (over: Partial<BuyoutPackage>): BuyoutPackage => ({ package_id: U(1), job_id: J, name: 'Div 26', csi_division: '26', status: 'OPEN', sort: 26, lead_time_days: 30, budget_cents: 100_000, committed_cents: 0, need_by: null, days_to_need: null, ...over });
  it('summarizes bought %, savings on bought packages, and need-date risk', () => {
    const s = buyoutSummary([
      p({ package_id: U(1), status: 'AWARDED', budget_cents: 100_000, committed_cents: 90_000 }),
      p({ package_id: U(2), status: 'OPEN', budget_cents: 300_000, days_to_need: 5 }),
      p({ package_id: U(3), status: 'BIDDING', budget_cents: 100_000, days_to_need: -3 }),
      p({ package_id: U(4), status: 'NOT_NEEDED', budget_cents: 999_999 }),
    ]);
    expect(s).toMatchObject({ packages: 4, bought: 1, open: 2, budget: 500_000, committed: 90_000, savings: 10_000, atRisk: 1, late: 1 });
    expect(s.pctBought).toBeCloseTo(0.2);
    expect(buyoutRisk({ status: 'AWARDED', days_to_need: -9 })).toBeNull();
    expect(buyoutRisk({ status: 'OPEN', days_to_need: 30 })).toBeNull();
  });
});

describe('billing calendar (CGC-102)', () => {
  const base = { current_status: null, current_stage: null, portal_status: null, next_cutoff: '2026-10-25', pencil_due: '2026-10-20' };
  it('names where the period stands', () => {
    expect(calendarState({ ...base, portal_status: 'PAID' }, '2026-10-21')).toBe('PAID');
    expect(calendarState({ ...base, current_stage: 'FINAL' }, '2026-10-21')).toBe('APPROVED');
    expect(calendarState({ ...base, current_stage: 'PENCIL_SENT' }, '2026-10-21')).toBe('SUBMITTED');
    expect(calendarState({ ...base, current_stage: 'PENCIL' }, '2026-10-21')).toBe('PENCIL');
    expect(calendarState({ ...base, current_stage: 'PENCIL' }, '2026-10-26')).toBe('LATE');
    expect(calendarState(base, '2026-10-18')).toBe('DUE_SOON');
    expect(calendarState({ ...base, pencil_due: '2026-10-30', next_cutoff: '2026-11-05' }, '2026-10-01')).toBe('NOT_STARTED');
  });
  it('lays a Monday-first month with the cutoff (clamped to month end) and pencil days', () => {
    const g = monthGrid('2026-02', [{ job_id: J, billing_cutoff_day: 30, next_cutoff: '2026-02-28', pencil_due: '2026-02-23' }]);
    expect(g).toHaveLength(42);
    expect(g[0]!.date).toBe('2026-01-26');
    expect(g.find((d) => d.date === '2026-02-28')!.cutoffs).toEqual([J]);
    expect(g.find((d) => d.date === '2026-02-23')!.pencils).toEqual([J]);
  });
  it('week helpers', () => {
    expect(mondayOf('2026-10-25')).toBe('2026-10-19');
    expect(weekStarts('2026-10-21', 3)).toEqual(['2026-10-19', '2026-10-26', '2026-11-02']);
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('rolls retainage and late jobs up by GC', () => {
    const row = { job_id: J, location_id: U(9), job_number: '1', job_name: 'A', customer_name: 'Turner', billing_form: 'TEXTURA', billing_portal_url: null, billing_cutoff_day: 25, next_cutoff: '2026-10-25', pencil_due: '2026-10-20', current_status: null, current_stage: null, portal_status: null, retainage_outstanding_cents: 30_000 };
    expect(byGc([row, { ...row, job_id: J2, retainage_outstanding_cents: 10_000 }], { [J]: { billed: 500 } }, '2026-10-27')).toEqual([{ gc: 'Turner', jobs: 2, retainage: 40_000, billed: 500, late: 2 }]);
  });
});

describe('OSHA (CGC-79)', () => {
  it('rates per 200,000 hours', () => {
    expect(oshaRate(2, 100_000)).toBe(4);
    expect(oshaRate(1, 0)).toBeNull();
  });
  it('suggests the recordable determination for review', () => {
    const i = { incident_type: 'INJURY', is_employee: true, days_away: 0, days_restricted: 0, injury_nature: null };
    expect(suggestRecordable({ ...i, days_away: 3 })).toMatchObject({ recordable: true, classification: 'DAYS_AWAY' });
    expect(suggestRecordable({ ...i, days_restricted: 2 })).toMatchObject({ recordable: true, classification: 'RESTRICTED_OR_TRANSFER' });
    expect(suggestRecordable({ ...i, incident_type: 'NEAR_MISS' }).recordable).toBe(false);
    expect(suggestRecordable({ ...i, is_employee: false }).recordable).toBe(false);
    expect(suggestRecordable({ ...i, injury_nature: 'first aid — bandage' }).recordable).toBe(false);
    expect(suggestRecordable(i).recordable).toBeNull();
  });
  it('toolbox topics lead with the site’s open hazards, in the crew’s language', () => {
    expect(suggestTopics(['Open floor edge', 'Open floor edge'], 'en', 3)).toEqual(['On our site: Open floor edge', 'Fall protection at leading edges and openings', 'Ladder setup and three points of contact']);
    expect(suggestTopics([], 'es', 1)).toEqual(['Protección contra caídas en bordes y aberturas']);
  });
});

describe('workforce board (CGC-92)', () => {
  const emp = [{ id: U(1), name: 'Ann Lee', title: 'Foreman' }, { id: U(2), name: 'Bo Diaz', title: 'Apprentice' }, { id: U(3), name: 'Cy Park', title: 'Journeyman' }];
  const a = (over: Partial<Assignment>): Assignment => ({ id: U(50), job_id: J, employee_id: U(1), request_id: null, role: 'FOREMAN', week_start: '2026-10-19', days: 5, per_diem: false, travel: false, status: 'PLANNED', ...over });
  it('grids people by week, flags booked days and counts the bench', () => {
    const g = workforceGrid(emp, [a({}), a({ id: U(51), job_id: J2, days: 2 }), a({ id: U(52), employee_id: U(2), status: 'RELEASED' })], ['2026-10-19', '2026-10-26']);
    expect(g.rows[0]!.employee.name).toBe('Ann Lee');
    expect(g.rows[0]!.cells[0]!.days).toBe(7);
    expect(g.bench).toEqual([2, 3]);
  });
  it('fills a request by week and proposes bench people whose title fits first', () => {
    const req = { id: U(70), job_id: J, role: 'JOURNEYMAN', headcount: 2, start_week: '2026-10-19', end_week: '2026-10-26', status: 'OPEN', trade: null };
    expect(requestFill(req, [a({ role: 'JOURNEYMAN', request_id: U(70) })], ['2026-10-19', '2026-10-26', '2026-11-02'])).toEqual([{ week: '2026-10-19', filled: 1, need: 2 }, { week: '2026-10-26', filled: 0, need: 2 }]);
    expect(proposeFill(req, 0, emp).map((e) => e.name)).toEqual(['Cy Park', 'Ann Lee']);
    expect(proposeFill(req, 2, emp)).toEqual([]);
  });
});

describe('job cost drill-down (CGC-55)', () => {
  const c = (over: Partial<CostDetailRow>): CostDetailRow => ({ id: U(1), occurred_on: '2026-10-03', cost_code_id: U(10), cost_code: '26-100', cost_type: 'LABOR', amount_cents: 1000, lifecycle: 'CLEARED', gate: 'TIMESHEET_PAYROLL', source_ref: 'PR-77', gl_entry_id: null, vendor_id: null, description: 'Payroll', commitment_line_id: null, commitment_number: null, ...over });
  it('names the source from the Books gate or reference', () => {
    expect(costSource(c({}))).toBe('PAYROLL');
    expect(costSource(c({ gate: 'PAYABLE_APPROVAL', source_ref: 'x' }))).toBe('AP_BILL');
    expect(costSource(c({ gate: null, source_ref: 'BANK:9' }))).toBe('BANK');
    expect(costSource(c({ gate: null, source_ref: 'JE-1', cost_type: 'OTHER' }))).toBe('JOURNAL');
    expect(costSource(c({ gate: null, source_ref: 'misc', cost_type: 'EQUIPMENT' }))).toBe('EQUIPMENT');
  });
  it('groups by code, type, month or source with totals and pending', () => {
    const rows = [c({}), c({ id: U(2), amount_cents: 5000, lifecycle: 'PENDING', cost_type: 'MATERIALS', occurred_on: '2026-09-30', gate: 'PAYABLE_APPROVAL' }), c({ id: U(3), cost_code_id: null, cost_code: null, amount_cents: 200 })];
    const byCode = groupCosts(rows, 'code', () => 'Branch wiring');
    expect(byCode.map((g) => [g.label, g.total, g.pending])).toEqual([['26-100 Branch wiring', 6000, 5000], ['No cost code', 200, 0]]);
    expect(groupCosts(rows, 'month').map((g) => g.key)).toEqual(['2026-10', '2026-09']);
    expect(groupCosts(rows, 'source').map((g) => g.label)).toEqual(['AP bill', 'Payroll']);
    expect(groupCosts(rows, 'type')[0]!.label).toBe('Materials');
  });
});

describe('closeout and the close gate (CGC-103/106)', () => {
  it('status by sub, the contractor’s own items first', () => {
    const items = [
      { id: U(1), category: 'WARRANTY', title: 'W', vendor_id: U(9), required: true, status: 'ACCEPTED', due_on: null },
      { id: U(2), category: 'OM_MANUAL', title: 'O', vendor_id: U(9), required: true, status: 'REQUESTED', due_on: '2026-10-01' },
      { id: U(3), category: 'KEYS', title: 'K', vendor_id: null, required: true, status: 'WAIVED', due_on: null },
      { id: U(4), category: 'OTHER', title: 'opt', vendor_id: null, required: false, status: 'REQUIRED', due_on: '2026-01-01' },
    ];
    const g = closeoutBySub(items, () => 'Sparky Electric', '2026-10-25');
    expect(g.map((x) => [x.label, x.done, x.required, x.late])).toEqual([['General (our own)', 1, 1, 0], ['Sparky Electric', 1, 2, 1]]);
  });
  it('every close-gate blocker the RPC raises has an owner and a fix link', () => {
    for (const code of ['FINAL_BILLING', 'BILLING_IN_FLIGHT', 'COMMITMENTS_OPEN', 'FINAL_WAIVERS', 'RECEIVED_NOT_BILLED', 'PAYABLE_RETAINAGE', 'SUB_PAY_APPS', 'TM_UNBILLED', 'CHANGES_OPEN', 'PUNCH_OPEN', 'CLOSEOUT_ITEMS']) {
      expect(GATE_FIX[code], code).toBeTruthy();
      expect(GATE_FIX[code]!.href(J)).toMatch(/^\//);
    }
  });
});

describe('correspondence (CGC-67)', () => {
  it('drafts the notice around the event and flags responses due', () => {
    const d = letterDraft('NOTICE_OF_DELAY', { jobLabel: '26-0533', toName: 'Pat', toCompany: 'Owner LLC', fromName: 'Mike', date: '2026-10-25', event: 'late steel', days: 4 });
    expect(d.subject).toBe('Notice of delay — 26-0533');
    expect(d.body).toContain('delayed by late steel');
    expect(d.body).toContain('4 working days');
    expect(letterDraft('BACKCHARGE_NOTICE', { jobLabel: 'J', toName: null, toCompany: null, fromName: null, date: '2026-10-25', event: null, days: null }).body).toContain('[describe the event]');
    expect(awaitingResponse({ response_required_by: '2026-10-30', responded_on: null, status: 'SENT' })).toBe(true);
    expect(awaitingResponse({ response_required_by: '2026-10-30', responded_on: '2026-10-28', status: 'RESPONDED' })).toBe(false);
    expect(awaitingResponse({ response_required_by: null, responded_on: null, status: 'SENT' })).toBe(false);
  });
});

describe('view helpers', () => {
  it('distribution-group emails are deduped and lower-cased', () => {
    const e = (email: string | null, groups: string[]) => ({ email, distribution_groups: groups } as unknown as DirectoryEntry);
    expect(groupEmails([e('A@x.com', ['oac']), e('a@x.com', ['oac']), e('b@x.com', ['subs']), e(null, ['oac'])], 'oac')).toEqual(['a@x.com']);
    expect(groupEmails([e('A@x.com', ['oac']), e('b@x.com', [])], null)).toEqual(['a@x.com', 'b@x.com']);
  });
  it('template reach counts open jobs on an older version', () => {
    const apps = [{ job_id: J, template_id: U(1), version: 1, applied_at: '' }, { job_id: J2, template_id: U(1), version: 3, applied_at: '' }, { job_id: U(5), template_id: U(1), version: 1, applied_at: '' }];
    expect(templateReach({ id: U(1), version: 3 }, apps, new Set([J, J2]))).toEqual({ jobs: 2, behind: 1 });
  });
  it('proposal total = base + the alternates taken (deducts too)', () => {
    expect(proposalTotal({ base_bid_cents: 100_000, alternates: [{ label: 'a', amount_cents: 5_000 }, { label: 'b', amount_cents: -2_000 }] }, [0, 1])).toBe(103_000);
    expect(proposalTotal({ base_bid_cents: 100_000, alternates: [{ label: 'a', amount_cents: 5_000 }] }, [])).toBe(100_000);
  });
  it('inspection blockers: unanswered and missing photos; N/A needs no photo', () => {
    expect(inspectionBlockers([{ response: null, requires_photo: false, photo_ids: [] }, { response: 'PASS', requires_photo: true, photo_ids: [] }, { response: 'NA', requires_photo: true, photo_ids: [] }, { response: 'FAIL', requires_photo: false, photo_ids: [] }]))
      .toEqual({ unanswered: 1, needPhoto: 1, fails: 1 });
  });
  it('observations sort open-first by priority and due; repeat quality issues by a sub surface', () => {
    const o = (id: number, over: Partial<Observation>): Observation => ({ id: U(id), job_id: J, number: null, obs_type: 'QUALITY', priority: 'MEDIUM', title: 't', description: null, hazard: null, contributing_condition: null, assignee_vendor_id: U(9), assignee_name: 'Sparky', due_on: null, status: 'OPEN', closed_at: null, inspection_item_id: null, created_at: '2026-10-01T00:00:00Z', ...over });
    const xs = [o(1, { status: 'CLOSED', priority: 'CRITICAL' }), o(2, { priority: 'LOW' }), o(3, { priority: 'HIGH', due_on: '2026-11-01' }), o(4, { priority: 'HIGH', due_on: '2026-10-01' })];
    expect(sortObservations(xs).map((x) => x.id)).toEqual([U(4), U(3), U(2), U(1)]);
    expect(repeatOffenders(xs)).toEqual([{ jobId: J, key: `${J}|${U(9)}`, name: 'Sparky', count: 4 }]);
    expect(repeatOffenders(xs.slice(0, 2))).toEqual([]);
  });
  it('productivity totals: factor = earned ÷ actual, % complete by earned hours', () => {
    const r = { cost_code_id: U(1), cost_code: '1', cost_code_name: 'x', uom: 'LF', budget_qty: 100, budget_hours: 100, unit_hours: 1, installed_qty: 50, pct_complete: 0.5, earned_hours: 50, actual_hours: 60, productivity_factor: 0.83, pct_hours_used: 0.6, projected_hours: 120, variance_hours: 20 };
    const t = productivityTotals([r, { ...r, cost_code_id: U(2), budget_hours: 100, earned_hours: 50, actual_hours: 40 }]);
    expect(t.factor).toBe(1);
    expect(t.pctComplete).toBe(0.5);
    expect(t.projected).toBe(200);
    expect(productivityTotals([]).factor).toBeNull();
  });
  it('the foreman plan counts', () => {
    expect(planCounts({ date: '2026-10-25', crew: [{ employee_id: U(1), role: 'FOREMAN', name: 'A' }], tasks: [], deliveries: [], jha: [{ id: U(2), task: 't', status: 'SIGNED', steps: [], ppe: [] }], hazards: [], sheets: [], yesterday: [] }))
      .toEqual({ crew: 1, tasks: 0, deliveries: 0, hazards: 0, jhaSigned: true });
  });
  it('review commentary pre-writes from the EAC move and the worst cost codes', () => {
    const text = draftCommentary({
      eac: { total_eac_cents: 1_200_000, prior_eac_cents: 1_000_000, reason_code: 'PRODUCTIVITY' },
      cost_codes: [{ cost_code: '26-100', cost_code_name: 'Branch', budget_cents: 500_000, forecast_cents: 560_000 }, { cost_code: '26-200', cost_code_name: 'Gear', budget_cents: 100_000, forecast_cents: 90_000 }],
      documents: { rfis_open: 3, rfis_overdue: 1, submittals_open: 0, submittals_late: 2 },
    }, (c) => `$${c / 100}`);
    expect(text).toBe('Forecast cost at completion is up $2000 from last month (productivity).\n26-100 Branch: forecast $600 over its budget of $5000.\n1 RFIs overdue and 2 submittals late to submit.');
    expect(draftCommentary({})).toBe('No significant variances this month.');
  });
});

describe('route schemas', () => {
  it('quantities need a quantity or a percent; incidents need a classification when recordable', () => {
    expect(QuantityCreate.safeParse({ jobId: J, costCodeId: J2, workDate: '2026-10-25' }).success).toBe(false);
    expect(QuantityCreate.safeParse({ jobId: J, costCodeId: J2, workDate: '2026-10-25', pctComplete: 0.4 }).success).toBe(true);
    expect(IncidentUpdate.safeParse({ oshaRecordable: true, oshaClassification: null }).success).toBe(false);
    expect(IncidentUpdate.safeParse({ oshaRecordable: true, oshaClassification: 'DAYS_AWAY' }).success).toBe(true);
  });
  it('directory, profile, proposal, spec and template bodies', () => {
    expect(DirectoryEntryCreate.safeParse({ jobId: J, partyRole: 'ARCHITECT' }).success).toBe(false);
    expect(DirectoryEntryCreate.safeParse({ jobId: J, partyRole: 'ARCHITECT', companyName: 'HGA' }).success).toBe(true);
    expect(ProfileUpsert.safeParse({ vendorId: J, customerId: J2 }).success).toBe(false);
    expect(ProfileUpsert.safeParse({ vendorId: J, emr: 0.82 }).success).toBe(true);
    expect(ProposalCreate.safeParse({ companyId: J, projectName: 'Tower', baseBidCents: -1 }).success).toBe(false);
    expect(SpecImport.safeParse({ jobId: J, sections: [] }).success).toBe(false);
    expect(TemplateUpdate.safeParse({ payload: { retainage_steps: [{ from_pct: 0.5, rate: 0.05 }] } }).success).toBe(true);
    expect(TemplateUpdate.safeParse({ payload: { contract_settings: { billing_cutoff_day: 40 } } }).success).toBe(false);
    expect(CloseoutItemUpdate.parse({ dueOn: null })).toEqual({ dueOn: null });
  });
  it('template keys and column mapping', () => {
    expect(templateKey('Ground-up — Hospital')).toBe('ground_up_hospital');
    expect(templateKey('2026 Retrofit')).toBe('retrofit');
    expect(templateKey('!!!')).toBe('custom');
    expect(toColumns({ a: 1, b: undefined, c: null }, { a: 'col_a', b: 'col_b', c: 'col_c', d: 'col_d' })).toEqual({ col_a: 1, col_c: null });
  });
});
