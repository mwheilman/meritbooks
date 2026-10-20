/**
 * Dealer report builders R1–R8: footing (section subtotals sum to totals; the
 * departmental P&L columns sum to Total and foot to the P&L), the StatementModel
 * conversion validates against statementModelSchema, and drill links are present.
 */
import { describe, expect, it } from 'vitest';
import { statementModelSchema } from '@/lib/reports/export/statement-model';
import type { DealerReport, DealerReportRow } from './catalog';
import { DEALER_REPORT_KEYS } from './catalog';
import { toStatementModel, sumColumn } from './model';
import { buildFloorPlanInterest, buildFloorPlanPosition, freeFloorDaysUsed } from './build-floor-plan';
import { buildUnitAging, buildUnitGross, dealGross } from './build-units';
import { buildIncentiveAging, buildWarrantyAging, warrantyRates } from './build-receivables';
import { buildDeptPnl, type PnlLineIn } from './build-dept-pnl';
import { booksPrincipal, buildLenderRec, lineContribution } from './build-lender-rec';
import { dealerReportParams, dealerModelFromPayload, singleClient } from './export-spec';

const col = (r: DealerReport, key: string) => r.columns.findIndex((c) => c.key === key);
const val = (r: DealerReport, row: DealerReportRow | undefined, key: string) => (row ? row.values[col(r, key)] : undefined);
const byLabel = (r: DealerReport, label: string, kind?: DealerReportRow['kind']) => r.rows.find((x) => x.label === label && (!kind || x.kind === kind));
const total = (r: DealerReport) => r.rows.find((x) => x.kind === 'total');

function expectValidModel(r: DealerReport) {
  const m = toStatementModel(r);
  expect(() => statementModelSchema.parse(m)).not.toThrow();
  expect(m.rows.length).toBe(r.rows.length + (r.notes.length || r.kpis.length ? 1 + r.notes.length + r.kpis.length : 0));
  for (const row of m.rows) expect(row.values.length).toBe(m.columns.length);
  // money stays integer cents
  r.columns.forEach((c, i) => {
    if (c.kind !== 'money') return;
    for (const row of m.rows) if (typeof row.values[i] === 'number') expect(Number.isInteger(row.values[i])).toBe(true);
  });
  return m;
}

/** Sum of the given column over the rows between a section header and the next subtotal. */
function sectionsFoot(r: DealerReport, key: string) {
  const i = col(r, key);
  let acc = 0;
  let inSec = false;
  for (const row of r.rows) {
    if (row.kind === 'section') { acc = 0; inSec = true; continue; }
    if (row.kind === 'account' && inSec) acc += Number(row.values[i] ?? 0);
    if (row.kind === 'subtotal' && inSec) { expect(Number(row.values[i] ?? 0)).toBe(acc); inSec = false; }
  }
}

describe('R1 floor-plan position', () => {
  const r = buildFloorPlanPosition({
    asOf: '2026-10-20',
    entityLabel: 'Client A',
    lines: [
      { lineId: 'l1', lineName: 'Main line', lenderVendorId: 'v1', lineStatus: 'ACTIVE', creditLimitCents: 5_000_000, accruedInterestCents: 7_397 },
      { lineId: 'l2', lineName: 'Used line', lenderVendorId: 'v1', lineStatus: 'CREDIT_HOLD', creditLimitCents: 1_000_000, accruedInterestCents: 0 },
    ],
    notes: [
      { id: 'n1', line_id: 'l1', program_id: 'p1', principal_balance_cents: 1_000_000, maturity_date: '2027-01-01' },
      { id: 'n2', line_id: 'l1', program_id: 'p1', principal_balance_cents: 900_000, maturity_date: '2026-12-01' },
      { id: 'n3', line_id: 'l1', program_id: null, principal_balance_cents: 100_000, maturity_date: null },
      { id: 'n4', line_id: 'l2', program_id: 'p2', principal_balance_cents: 250_000, maturity_date: '2026-11-19' },
    ],
    programNames: new Map([['p1', 'New 90 free'], ['p2', 'Used std']]),
    lenderNames: new Map([['v1', 'Lender One']]),
    curtailments: [{ note_id: 'n2', amount_cents: 100_000 }],
    sot: [{ noteId: 'n2', principalCents: 900_000 }],
  });
  it('programs foot to their line, lines to the lender, lender to the total', () => {
    const main = byLabel(r, 'Main line total', 'subtotal');
    expect(val(r, main, 'principal')).toBe(2_000_000);
    expect(val(r, main, 'util')).toBe(4000);
    expect(val(r, main, 'sotCount')).toBe(1);
    expect(val(r, main, 'maturity')).toBe(42);
    expect(val(r, byLabel(r, 'Lender One total', 'subtotal'), 'principal')).toBe(2_250_000);
    expect(val(r, total(r), 'principal')).toBe(2_250_000);
    expect(val(r, total(r), 'accrued')).toBe(7_397);
    expect(val(r, total(r), 'curt30')).toBe(100_000);
    expect(val(r, total(r), 'limit')).toBe(6_000_000);
    expect(r.rows.some((x) => x.label === 'Used line (credit hold)')).toBe(true);
  });
  it('rows drill to the floor plan; the model validates', () => {
    expect(byLabel(r, 'New 90 free')?.href).toContain('/dealer/floor-plan');
    expectValidModel(r);
  });
});

describe('R2 floor-plan interest', () => {
  const r = buildFloorPlanInterest({
    start: '2026-09-01',
    end: '2026-10-31',
    entityLabel: 'Client A',
    accruals: [
      { note_id: 'n1', txn_date: '2026-09-30', interest_cents: 7_397 },
      { note_id: 'n1', txn_date: '2026-10-31', interest_cents: 7_644 },
      { note_id: 'n2', txn_date: '2026-10-31', interest_cents: 1_000 },
    ],
    billings: [{ line_id: 'l1', txn_date: '2026-10-05', interest_cents: 7_410, accrual_cleared_cents: 7_397 }],
    notes: new Map([
      ['n1', { id: 'n1', unit_id: 'u1', line_id: 'l1', floored_date: '2026-06-01', free_floor_end_date: '2026-08-30' }],
      ['n2', { id: 'n2', unit_id: 'u2', line_id: 'l1', floored_date: '2026-10-01', free_floor_end_date: '2026-12-30' }],
    ]),
    units: new Map([
      ['u1', { id: 'u1', serial_number: 'A1', department_role: 'WG_NEW' as const, make_vendor_id: 'm1' }],
      ['u2', { id: 'u2', serial_number: 'B2', department_role: 'WG_USED' as const, make_vendor_id: null }],
    ]),
    makeNames: new Map([['m1', 'Maker']]),
    sold: [{ saleId: 's1', unitId: 'u1', saleDate: '2026-10-15', lifetimeInterestCents: 15_041, noteIds: ['n1'] }],
  });
  it('every view (month, department, manufacturer, unit) foots to the total incl. the 13¢ true-up', () => {
    const t = Number(val(r, total(r), 'total'));
    expect(t).toBe(7_397 + 7_644 + 1_000 + 13);
    for (const label of ['Total by month', 'Total by department', 'Total by manufacturer', 'Total by unit']) {
      expect(val(r, byLabel(r, label, 'subtotal'), 'total')).toBe(t);
    }
    sectionsFoot(r, 'total');
    expect(r.kpis[0]).toMatchObject({ label: 'Interest per unit sold', value: '$150.41' });
  });
  it('free-floor days used stop at the free period end', () => {
    expect(freeFloorDaysUsed({ floored_date: '2026-06-01', free_floor_end_date: '2026-08-30' }, '2026-10-31')).toBe(90);
    expect(freeFloorDaysUsed({ floored_date: '2026-10-01', free_floor_end_date: '2026-12-30' }, '2026-10-31')).toBe(30);
    expectValidModel(r);
  });
});

describe('R3 unit aging', () => {
  const unit = (id: string, over: Record<string, unknown> = {}) => ({
    unit_id: id, serial_number: id.toUpperCase(), stock_number: null, make_vendor_id: 'm1', model: 'X9', model_year: 2026, condition: 'NEW', status: 'IN_STOCK',
    is_consignment: false, cost_cents: 100_000, received_date: '2026-09-01', principal_balance_cents: null, maturity_date: null, is_floored: false, ...over,
  });
  const r = buildUnitAging({
    asOf: '2026-10-20', entityLabel: 'Client A', edges: [90, 180], makeNames: new Map([['m1', 'Maker']]),
    units: [
      unit('a'),
      unit('b', { received_date: '2026-03-01', is_floored: true, principal_balance_cents: 90_000, maturity_date: '2026-11-01' }),
      unit('c', { condition: 'USED', received_date: null, cost_cents: 50_000 }),
      unit('d', { condition: 'DEMO' }),
      unit('e', { is_consignment: true }),
      unit('f', { received_date: '2026-11-01' }),
    ],
  });
  it('buckets + not-received = cost; floored + owned = cost; per-condition subtotals foot to the total', () => {
    const t = total(r)!;
    const cost = Number(val(r, t, 'cost'));
    expect(cost).toBe(350_000);
    const buckets = r.columns.filter((c) => /^b\d$/.test(c.key) || c.key === 'undated').reduce((s, c) => s + Number(t.values[col(r, c.key)] ?? 0), 0);
    expect(buckets).toBe(cost);
    expect(Number(val(r, t, 'floored')) + Number(val(r, t, 'owned'))).toBe(cost);
    expect(val(r, t, 'term')).toBe(12);
    sectionsFoot(r, 'cost');
    sectionsFoot(r, 'units');
    expect(r.notes.some((n) => /consignment/.test(n))).toBe(true);
    expect(r.rows.find((x) => x.label.startsWith('Serial D'))?.label).toMatch(/demo/);
    expect(r.rows.find((x) => x.label.startsWith('Serial A'))?.href).toBe('/dealer/units/a');
    expectValidModel(r);
  });
});

describe('R4 unit gross', () => {
  it('gross = price − cost − over-allowance + cost-reduction incentives; every view foots', () => {
    expect(dealGross({ price: 1_500_000, cost: 1_040_000, over: 50_000, incentives: 20_000 }).gross).toBe(430_000);
    const r = buildUnitGross({
      start: '2026-10-01', end: '2026-10-31', entityLabel: 'Client A',
      sales: [
        { id: 's1', unit_id: 'u1', sale_date: '2026-10-05', sale_price_cents: 1_500_000, cogs_cents: 1_040_000, salesperson: 'Pat', trade_in_id: 't1', gl_entry_id: 'je1', external_deal_ref: null },
        { id: 's2', unit_id: 'u2', sale_date: '2026-10-09', sale_price_cents: 800_000, cogs_cents: null, salesperson: null, trade_in_id: null, gl_entry_id: null, external_deal_ref: 'D-9' },
        { id: 's3', unit_id: 'u3', sale_date: '2026-10-12', sale_price_cents: 600_000, cogs_cents: 500_000, salesperson: 'Pat', trade_in_id: null, gl_entry_id: null, external_deal_ref: null },
      ],
      units: new Map([
        ['u1', { serial_number: 'A1', make_vendor_id: 'm1', department_role: 'WG_NEW' as const, model: 'X' }],
        ['u2', { serial_number: 'B2', make_vendor_id: null, department_role: 'WG_USED' as const, model: null }],
        ['u3', { serial_number: 'C3', make_vendor_id: 'm1', department_role: 'WG_NEW' as const, model: 'Y' }],
      ]),
      makeNames: new Map([['m1', 'Maker']]),
      overAllowance: new Map([['t1', 50_000]]),
      incentives: [{ unit_id: 'u1', sale_id: 's1', amount_cents: 20_000 }],
    });
    const g = Number(val(r, total(r), 'gross'));
    expect(g).toBe(430_000 + 800_000 + 100_000);
    expect(val(r, total(r), 'grossPct')).toBe(Math.round((g * 10_000) / 2_900_000));
    const gi = col(r, 'gross');
    const subs = r.rows.filter((x) => x.kind === 'subtotal').reduce((s, x) => s + Number(x.values[gi]), 0);
    expect(subs).toBe(g);
    sectionsFoot(r, 'gross');
    // By make / by department re-group the same deals
    const idx = (title: string) => r.rows.findIndex((x) => x.label === title && x.kind === 'section');
    for (const title of ['By make', 'By department']) {
      const start = idx(title) + 1;
      let s = 0;
      for (let i = start; i < r.rows.length && r.rows[i].kind === 'account'; i++) s += Number(r.rows[i].values[gi]);
      expect(s).toBe(g);
    }
    const deal = r.rows.find((x) => x.href === '/dealer/deals/s1');
    expect(deal?.jeHref).toBe('/journal-entries?id=je1');
    expect(r.rows.find((x) => x.href === '/dealer/deals/s2')?.tone).toBe('warning');
    expectValidModel(r);
  });
});

describe('R5 warranty aging and R6 incentive aging', () => {
  const w = (id: string, over: Record<string, unknown> = {}) => ({
    id, oem_vendor_id: 'oem', oem_claim_number: id, dealer_claim_ref: null, serial_number: null, status: 'SUBMITTED' as const,
    claimed_cents: 10_000, settled_cents: 0, written_off_cents: 0, submitted_date: '2026-10-01', ...over,
  });
  it('R5: OEM subtotals and status rows both foot to the total; buckets + unsubmitted = open', () => {
    const claims = [
      w('a'),
      w('b', { submitted_date: '2026-07-01' }),
      w('c', { status: 'DRAFT', submitted_date: null }),
      w('d', { status: 'PARTIAL', settled_cents: 6_000 }),
      w('e', { status: 'PAID', settled_cents: 10_000 }),
      w('f', { status: 'REJECTED' }),
      w('g', { oem_vendor_id: 'oem2' }),
    ];
    const r = buildWarrantyAging({ asOf: '2026-10-20', entityLabel: 'Client A', claims, rejectedClaimIds: new Set(['a']), oemNames: new Map([['oem', 'Maker'], ['oem2', 'Other']]) });
    const t = total(r)!;
    expect(val(r, t, 'open')).toBe(10_000 * 5 + 4_000);
    const buckets = r.columns.filter((c) => /^b\d$/.test(c.key) || c.key === 'unsubmitted').reduce((s, c) => s + Number(t.values[col(r, c.key)] ?? 0), 0);
    expect(buckets).toBe(val(r, t, 'open'));
    sectionsFoot(r, 'open');
    const subs = r.rows.filter((x) => x.kind === 'subtotal').reduce((s, x) => s + Number(x.values[col(r, 'open')]), 0);
    expect(subs).toBe(val(r, t, 'open'));
    const rates = warrantyRates(claims.filter((c) => c.oem_vendor_id === 'oem'), new Set(['a']));
    expect(rates.rejection).toBe(Math.round((2 * 10_000) / 5)); // a (event) + f (status) of 5 submitted
    expect(rates.recovery).toBe(5_000); // (10,000 + 0) / (10,000 + 10,000)
    expect(r.rows.find((x) => x.href === '/dealer/warranty?claim=a')).toBeTruthy();
    expect(r.notes.some((n) => /labor rate is not shown/.test(n))).toBe(true);
    expectValidModel(r);
  });
  it('R6: program → OEM → total foot; deadlines and drill links', () => {
    const ic = (id: string, over: Record<string, unknown> = {}) => ({
      id, program_id: 'p1', status: 'ACCRUED' as const, claim_reference: null, earned_date: '2026-09-01', submitted_date: null,
      claim_deadline: '2026-11-01', accrued_cents: 30_000, claimed_cents: 0, settled_cents: 0, written_off_cents: 0, ...over,
    });
    const r = buildIncentiveAging({
      asOf: '2026-10-20', entityLabel: 'Client A',
      claims: [ic('a'), ic('b', { claim_deadline: '2026-10-10' }), ic('c', { program_id: 'p2', status: 'SUBMITTED', submitted_date: '2026-10-01', claimed_cents: 40_000, settled_cents: 10_000 }), ic('d', { status: 'PAID', settled_cents: 30_000 }), ic('e', { earned_date: '2026-11-01' })],
      programs: new Map([['p1', { name: 'Fall rebate', oem_vendor_id: 'oem', program_type: 'DEALER_REBATE' as const }], ['p2', { name: 'Volume', oem_vendor_id: 'oem', program_type: 'VOLUME_BONUS' as const }]]),
      oemNames: new Map([['oem', 'Maker']]),
    });
    const t = total(r)!;
    expect(val(r, t, 'open')).toBe(30_000 + 30_000 + 30_000);
    expect(val(r, t, 'deadline')).toBe('2026-10-10');
    expect(val(r, byLabel(r, 'Maker total', 'subtotal'), 'open')).toBe(val(r, t, 'open'));
    expect(r.rows.find((x) => x.href === '/dealer/incentives?claim=b')?.tone).toBe('danger');
    expectValidModel(r);
  });
});

describe('R7 departmental P&L', () => {
  const L = (account_id: string, type: PnlLineIn['account_type'], dept: string | null, debit: number, credit: number): PnlLineIn => ({
    account_id, account_number: account_id, account_name: `Acct ${account_id}`, account_type: type, normal_balance: type === 'REVENUE' ? 'CREDIT' : 'DEBIT', department_id: dept, debit_cents: debit, credit_cents: credit,
  });
  const deptMap = [
    { dept_role: 'WG_NEW' as const, department_id: 'dNew' },
    { dept_role: 'WG_USED' as const, department_id: 'dUsed' },
    { dept_role: 'PARTS' as const, department_id: 'dPS' },
    { dept_role: 'SERVICE' as const, department_id: 'dPS' },
    { dept_role: 'RENTAL' as const, department_id: 'dRent' },
    { dept_role: 'ADMIN' as const, department_id: 'dAdm' },
  ];
  const lines = [
    L('4000', 'REVENUE', 'dNew', 0, 1_500_000),
    L('4100', 'REVENUE', 'dPS', 0, 300_000),
    L('5000', 'COGS', 'dNew', 1_040_000, 0),
    L('5100', 'COGS', 'dPS', 120_000, 0),
    L('6000', 'OPEX', 'dAdm', 150_000, 0),
    L('6100', 'OPEX', null, 50_000, 0),
    L('6200', 'OPEX', 'dElsewhere', 10_000, 0),
    L('7000', 'OTHER', 'dNew', 5_000, 0),
  ];
  const r = buildDeptPnl({ start: '2026-10-01', end: '2026-10-31', entityLabel: 'Client A', lines, deptMap, departmentNames: new Map([['dPS', 'Fixed ops']]) });
  it('department columns + Unassigned sum to Total on every row', () => {
    const dIdx = r.columns.map((c, i) => (c.key === 'total' ? -1 : i)).filter((i) => i >= 0);
    const tIdx = col(r, 'total');
    for (const row of r.rows.filter((x) => x.kind !== 'section' && x.kind !== 'spacer')) {
      expect(dIdx.reduce((s, i) => s + Number(row.values[i] ?? 0), 0)).toBe(row.values[tIdx]);
    }
    // Shared department → one column labelled with both roles.
    expect(r.columns.some((c) => c.label === 'Parts / Service')).toBe(true);
  });
  it('net income foots to the P&L (revenue − COGS − OPEX − other) and section subtotals foot', () => {
    expect(val(r, total(r), 'total')).toBe(1_800_000 - 1_160_000 - 210_000 - 5_000);
    expect(val(r, byLabel(r, 'Gross profit', 'subtotal'), 'total')).toBe(640_000);
    sectionsFoot(r, 'total');
    expect(val(r, byLabel(r, 'Total operating expenses', 'subtotal'), 'unassigned')).toBe(60_000);
  });
  it('service absorption = parts + service gross ÷ (admin + unassigned operating expenses)', () => {
    // (300,000 − 120,000) / (150,000 + 60,000) = 85.7%
    expect(r.kpis[0]).toMatchObject({ label: 'Service absorption', value: '85.7%' });
    expect(r.notes[0]).toMatch(/ratio only/);
    expectValidModel(r);
  });
});

describe('R8 lender reconciliation', () => {
  const lines = [
    { id: 'a', statement_id: 's1', line_number: 1, lender_invoice_number: 'I1', serial_number: 'S1', current_cents: 1_000_000, variance_cents: 0, match_status: 'MATCHED' as const, matched_note_id: 'n1', sau_flag: false, resolution: null, resolved_at: null },
    { id: 'b', statement_id: 's1', line_number: 2, lender_invoice_number: 'I2', serial_number: 'S2', current_cents: 500_500, variance_cents: 500, match_status: 'VARIANCE' as const, matched_note_id: 'n2', sau_flag: true, resolution: 'Lender fee', resolved_at: '2026-10-18T10:00:00Z' },
    { id: 'c', statement_id: 's1', line_number: 3, lender_invoice_number: 'I3', serial_number: 'S3', current_cents: 200_000, variance_cents: 0, match_status: 'LENDER_ONLY' as const, matched_note_id: null, sau_flag: false, resolution: null, resolved_at: null },
    { id: 'd', statement_id: 's1', line_number: null, lender_invoice_number: null, serial_number: 'S4', current_cents: null, variance_cents: 300_000, match_status: 'BOOKS_ONLY' as const, matched_note_id: 'n4', sau_flag: false, resolution: null, resolved_at: null },
  ];
  const r = buildLenderRec({
    start: '2026-10-01', end: '2026-10-31', entityLabel: 'Client A', toleranceCents: 100,
    statements: [{ id: 's1', line_id: 'l1', kind: 'AUDIT', statement_date: '2026-10-15', status: 'PREPARED', prepared_by: 'user_a', prepared_at: '2026-10-16T00:00:00Z', approved_by: null, approved_at: null, footer_principal_cents: 1_700_500 }],
    lines,
    lineNames: new Map([['l1', 'Main line']]),
    userNames: new Map([['user_a', 'Ann Preparer']]),
  });
  it('books principal from the match snapshot; line contributions explain the difference', () => {
    expect(booksPrincipal(lines)).toBe(1_000_000 + 500_000 + 300_000);
    const st = r.rows.find((x) => x.href === '/dealer/lender-statements/s1')!;
    expect(val(r, st, 'difference')).toBe(1_700_500 - 1_800_000);
    expect(lines.reduce((s, l) => s + lineContribution(l), 0)).toBe(val(r, st, 'difference'));
    expect(val(r, st, 'preparedBy')).toBe('Ann Preparer');
    expect(val(r, st, 'open')).toBe(3);
    expect(val(r, st, 'sau')).toBe(1);
    expect(val(r, st, 'clearDays')).toBe(3);
    expect(r.rows.some((x) => x.label.includes('Lender fee'))).toBe(true);
    const m = expectValidModel(r);
    expect(m.rows.find((x) => x.label.startsWith('Oct 15, 2026'))?.values[col(r, 'prepared')]).toBe('Oct 16, 2026');
  });
});

describe('export glue', () => {
  it('singleClient: exactly one id or nothing', () => {
    expect(singleClient('a')).toBe('a');
    expect(singleClient('a,b')).toBeNull();
    expect(singleClient('')).toBeNull();
  });
  it('as-of reports use the period end, never past today; period reports pass the window', () => {
    expect(dealerReportParams('dealer_unit_aging', { locationId: 'L', sd: '2026-10-01', ed: '2026-10-31', today: '2026-10-20' })).toEqual({ report: 'dealer_unit_aging', locationId: 'L', asOf: '2026-10-20' });
    expect(dealerReportParams('dealer_unit_aging', { locationId: 'L', ed: '2026-09-30', today: '2026-10-20' }).asOf).toBe('2026-09-30');
    expect(dealerReportParams('dealer_dept_pnl', { locationId: 'L', sd: '2026-10-01', ed: '2026-10-31' })).toMatchObject({ start: '2026-10-01', end: '2026-10-31' });
  });
  it('dealerModelFromPayload applies the viewer labels and rejects an empty payload', () => {
    const r = buildFloorPlanPosition({ asOf: '2026-10-20', entityLabel: 'Client A', lines: [], notes: [], programNames: new Map(), lenderNames: new Map(), curtailments: [], sot: [] });
    const m = dealerModelFromPayload({ data: { model: toStatementModel(r) } }, { reportLabel: 'Floor-plan position', accent: '#10b981' });
    expect(statementModelSchema.parse(m).title).toBe('Floor-plan position');
    expect(() => dealerModelFromPayload({ data: {} }, {})).toThrow();
    expect(DEALER_REPORT_KEYS).toHaveLength(8);
    expect(sumColumn(r.rows, r.columns, 'principal')).toBe(0);
  });
});
