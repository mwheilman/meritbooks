/**
 * Pure scorers for DL-1…DL-13 (except DL-9, raised at the API): thresholds at the
 * edges, stable dedup keys, severities, plain-English titles.
 */
import { describe, expect, it } from 'vitest';
import type { SotFinding } from '@/lib/dealer/engine/sot';
import { sotExceptions } from './sot';
import { curtailmentFindings, lineUtilizationFindings, type CurtailmentNote } from './floor-plan';
import { floorMismatchFindings } from './mismatch';
import { agedUnitFindings, crossedEdge, demoOnFloorFindings, type AgingUnitIn } from './units';
import { incentiveFindings, warrantyFindings, type IncentiveClaimIn, type WarrantyClaimIn } from './receivables';
import { statementFindings } from './statements';
import { tradeRiskFindings } from './trade-ins';
import { doubleFlooringFindings } from './double-flooring';

const ASOF = '2026-10-20';
const noCodes = (s: string) => expect(s).not.toMatch(/\b(DL-\d+|[A-Z]{3,}_[A-Z_]+)\b/);

describe('DL-1 sold out of trust', () => {
  const finding = (over: Partial<SotFinding> = {}): SotFinding => ({
    noteId: 'n1', unitId: 'u1', lineId: 'l1', serialNumber: '4471', severity: 'CRITICAL', detectedBy: 'BOOKS_SALE',
    saleMissingInBooks: false, earliestSaleDate: '2026-10-08', daysSinceSale: 12, payoffDueDate: '2026-10-08', daysPastDue: 12,
    principalCents: 900_000, evidence: [{ source: 'BOOKS_SALE', date: '2026-10-08', ref: null }], dedupKey: 'DL-1:n1', ...over,
  });
  it('keeps the engine dedup key and severity; title matches the spec wording', () => {
    const [x] = sotExceptions([finding()]);
    expect(x.dedupKey).toBe('DL-1:n1');
    expect(x.severity).toBe('CRITICAL');
    expect(x.title).toBe('Sold out of trust: serial 4471 · $9,000.00 unpaid 12 days');
    expect(x.href).toBe('/dealer/floor-plan/notes/n1');
    noCodes(x.title);
  });
  it('a HIGH (payoff pending) finding reads as pending, and a missing Books sale asks to record it', () => {
    expect(sotExceptions([finding({ severity: 'HIGH' })])[0].title).toMatch(/^Floor-plan payoff pending/);
    expect(sotExceptions([finding({ saleMissingInBooks: true, detectedBy: 'WARRANTY_REG' })])[0].question).toMatch(/Record the sale/);
  });
});

describe('DL-2 curtailments', () => {
  const notes = new Map<string, CurtailmentNote>([
    ['n1', { id: 'n1', status: 'OPEN', lender_invoice_number: 'INV-1', unit_id: 'u1', serial_number: 'SER123' }],
    ['n2', { id: 'n2', status: 'PAID_OFF', lender_invoice_number: 'INV-2', unit_id: 'u2', serial_number: 'SER456' }],
  ]);
  const c = (id: string, due: string, status: 'DUE' | 'MISSED' = 'DUE', note = 'n1') => ({ id, note_id: note, sequence: 1, due_date: due, amount_cents: 100_000, status });
  it('warns exactly within warn days, not one day beyond', () => {
    const out = curtailmentFindings({ asOf: ASOF, warnDays: 7, notes, curtailments: [c('a', '2026-10-27'), c('b', '2026-10-28')] });
    expect(out.map((x) => x.dedupKey)).toEqual(['DL-2:a:due']);
    expect(out[0].severity).toBe('MEDIUM');
  });
  it('a passed due date or MISSED status is HIGH with a different key (the due row expires)', () => {
    const out = curtailmentFindings({ asOf: ASOF, warnDays: 7, notes, curtailments: [c('a', '2026-10-19'), c('b', '2026-10-25', 'MISSED')] });
    expect(out.map((x) => [x.dedupKey, x.severity])).toEqual([['DL-2:a:missed', 'HIGH'], ['DL-2:b:missed', 'HIGH']]);
  });
  it('due today is still a warning; a curtailment on a paid-off note never fires', () => {
    expect(curtailmentFindings({ asOf: ASOF, warnDays: 7, notes, curtailments: [c('a', ASOF)] })[0].kind).toBe('due');
    expect(curtailmentFindings({ asOf: ASOF, warnDays: 7, notes, curtailments: [c('x', '2026-10-01', 'MISSED', 'n2')] })).toHaveLength(0);
  });
});

describe('DL-10 line utilization / credit hold', () => {
  const line = (over: Record<string, unknown> = {}) => ({ lineId: 'l1', lineName: 'Main line', lineStatus: 'ACTIVE', creditLimitCents: 1_000_000, principalCents: 900_000, ...over });
  it('fires at exactly the warning level, not below', () => {
    expect(lineUtilizationFindings({ asOf: ASOF, warnBps: 9000, lines: [line()] })[0].dedupKey).toBe('DL-10:l1:utilization:2026-10');
    expect(lineUtilizationFindings({ asOf: ASOF, warnBps: 9000, lines: [line({ principalCents: 899_999 })] })).toHaveLength(0);
  });
  it('credit hold is HIGH; a closed line never fires; no limit → no utilization', () => {
    const hold = lineUtilizationFindings({ asOf: ASOF, warnBps: 9000, lines: [line({ lineStatus: 'CREDIT_HOLD', principalCents: 1 })] });
    expect(hold.map((x) => [x.kind, x.severity])).toEqual([['credit_hold', 'HIGH']]);
    expect(lineUtilizationFindings({ asOf: ASOF, warnBps: 9000, lines: [line({ lineStatus: 'CLOSED' })] })).toHaveLength(0);
    expect(lineUtilizationFindings({ asOf: ASOF, warnBps: 9000, lines: [line({ creditLimitCents: 0 })] })).toHaveLength(0);
  });
});

describe('DL-3 floor plan / inventory / GL mismatch', () => {
  const unit = (id: string, status: string, source = 'LENDER') => ({ id, serial_number: `S-${id}`, status: status as 'IN_STOCK', source, cost_cents: 500_000 });
  it('a lender-sourced in-stock unit with no note fires; a paid-off note (owned unit) does not', () => {
    const out = floorMismatchFindings({
      asOf: ASOF, tieout: [], flooredCostUnitIds: new Set(),
      units: [unit('u1', 'IN_STOCK'), unit('u2', 'IN_STOCK'), unit('u3', 'IN_STOCK', 'MANUAL')],
      notes: [{ id: 'n2', unit_id: 'u2', status: 'PAID_OFF', principal_balance_cents: 0, lender_invoice_number: 'I2' }],
    });
    expect(out.map((x) => x.dedupKey)).toEqual(['DL-3:unit-no-note:u1']);
  });
  it('a flooring cost row marks a unit as floored even when the source is manual', () => {
    const out = floorMismatchFindings({ asOf: ASOF, tieout: [], flooredCostUnitIds: new Set(['u3']), units: [unit('u3', 'IN_STOCK', 'MANUAL')], notes: [] });
    expect(out).toHaveLength(1);
  });
  it('a live note on a returned unit fires; on a sold unit it is left to sold-out-of-trust', () => {
    const out = floorMismatchFindings({
      asOf: ASOF, tieout: [], flooredCostUnitIds: new Set(),
      units: [unit('u1', 'RETURNED'), unit('u2', 'SOLD')],
      notes: [
        { id: 'n1', unit_id: 'u1', status: 'OPEN', principal_balance_cents: 400_000, lender_invoice_number: 'I1' },
        { id: 'n2', unit_id: 'u2', status: 'SOLD_UNPAID', principal_balance_cents: 400_000, lender_invoice_number: 'I2' },
      ],
    });
    expect(out.map((x) => x.dedupKey)).toEqual(['DL-3:note-off-inventory:n1']);
  });
  it('every tie-out bucket off by even 1 cent or unmapped fires (tolerance 0); zero differences do not', () => {
    const out = floorMismatchFindings({
      asOf: ASOF, units: [], notes: [], flooredCostUnitIds: new Set(),
      tieout: [
        { bucket: 'FLOOR_PLAN_PAYABLE', account_id: 'a1', subledger_cents: 100, gl_cents: 99, difference_cents: 1 },
        { bucket: 'UNIT_INVENTORY', account_id: null, subledger_cents: 500, gl_cents: 0, difference_cents: 500 },
        { bucket: 'WARRANTY_RECEIVABLE', account_id: 'a3', subledger_cents: 5, gl_cents: 5, difference_cents: 0 },
      ],
    });
    expect(out.map((x) => x.dedupKey)).toEqual(['DL-3:tieout:FLOOR_PLAN_PAYABLE:a1:2026-10', 'DL-3:tieout:UNIT_INVENTORY:unmapped:2026-10']);
    expect(out[0].title).toBe("Dealer subledger doesn't tie to the GL: Floor plan payable · difference $0.01");
    noCodes(out[0].title);
  });
});

describe('DL-4 aged units / term, DL-12 demo on floor plan', () => {
  const u = (over: Partial<AgingUnitIn> = {}): AgingUnitIn => ({
    unit_id: 'u1', serial_number: 'S1', condition: 'NEW', status: 'IN_STOCK', is_consignment: false, cost_cents: 1_000_000,
    received_date: '2026-04-23', note_id: null, principal_balance_cents: null, maturity_date: null, ...over,
  });
  it('crossedEdge: the bucket edge is inclusive of its own day count', () => {
    expect(crossedEdge(90, [90, 180])).toBeNull();
    expect(crossedEdge(91, [90, 180])).toBe(90);
    expect(crossedEdge(400, [365, 90, 180, 270])).toBe(365);
  });
  it('keys per unit + edge, so the next edge is a new key', () => {
    // 2026-04-23 → 2026-10-20 = 180 days: still in the 91–180 bucket
    expect(agedUnitFindings({ asOf: ASOF, edges: [90, 180, 270, 365], termWarningDays: 60, units: [u()] }).map((x) => x.dedupKey)).toEqual(['DL-4:u1:age:90']);
    expect(agedUnitFindings({ asOf: ASOF, edges: [90, 180, 270, 365], termWarningDays: 60, units: [u({ received_date: '2026-04-22' })] }).map((x) => x.dedupKey)).toEqual(['DL-4:u1:age:180']);
  });
  it('term warning at exactly the warning window is HIGH; consignment units never age', () => {
    const out = agedUnitFindings({ asOf: ASOF, edges: [90], termWarningDays: 60, units: [u({ received_date: ASOF, note_id: 'n1', principal_balance_cents: 900_000, maturity_date: '2026-12-19' })] });
    expect(out.map((x) => [x.dedupKey, x.severity])).toEqual([['DL-4:u1:term:n1', 'HIGH']]);
    expect(agedUnitFindings({ asOf: ASOF, edges: [90], termWarningDays: 60, units: [u({ received_date: ASOF, note_id: 'n1', maturity_date: '2026-12-20' })] })).toHaveLength(0);
    expect(agedUnitFindings({ asOf: ASOF, edges: [90], termWarningDays: 60, units: [u({ is_consignment: true, received_date: '2020-01-01' })] })).toHaveLength(0);
  });
  it('DL-12: demo or rental on a live note without demo terms is LOW; demo terms clear it', () => {
    const base = u({ note_id: 'n1', principal_balance_cents: 500_000 });
    expect(demoOnFloorFindings([{ ...base, condition: 'DEMO', program: { id: 'p', name: 'Std', curtail_demos: false } }]).map((x) => [x.dedupKey, x.severity])).toEqual([['DL-12:n1', 'LOW']]);
    expect(demoOnFloorFindings([{ ...base, status: 'RENTAL', program: null }])).toHaveLength(1);
    expect(demoOnFloorFindings([{ ...base, condition: 'DEMO', program: { id: 'p', name: 'Demo', curtail_demos: true } }])).toHaveLength(0);
    expect(demoOnFloorFindings([{ ...base, program: null }])).toHaveLength(0);
  });
});

describe('DL-5 / DL-6 warranty, DL-7 incentives', () => {
  const w = (over: Partial<WarrantyClaimIn> = {}): WarrantyClaimIn => ({
    id: 'w1', oem_vendor_id: 'oem', oem_claim_number: 'C-1', dealer_claim_ref: null, serial_number: null, status: 'SUBMITTED',
    filing_deadline: null, submitted_date: '2026-09-05', claimed_cents: 29_400, settled_cents: 0, written_off_cents: 0, ...over,
  });
  const run = (claims: WarrantyClaimIn[], rejected: string[] = []) =>
    warrantyFindings({ asOf: ASOF, deadlineWarnDays: 5, submittedAgingDays: 45, claims, rejectedClaimIds: new Set(rejected), oemNames: new Map([['oem', 'Maker']]) });
  it('submitted aging fires only after more than the aging days', () => {
    expect(run([w({ submitted_date: '2026-09-05' })]).map((x) => x.dedupKey)).toEqual([]); // 45 days
    expect(run([w({ submitted_date: '2026-09-04' })]).map((x) => x.dedupKey)).toEqual(['DL-5:w1:aging']); // 46 days
  });
  it('a draft inside the filing window is HIGH', () => {
    expect(run([w({ status: 'DRAFT', submitted_date: null, filing_deadline: '2026-10-25' })]).map((x) => [x.dedupKey, x.severity])).toEqual([['DL-5:w1:deadline', 'HIGH']]);
    expect(run([w({ status: 'DRAFT', submitted_date: null, filing_deadline: '2026-10-26' })])).toHaveLength(0);
  });
  it('short-pay and rejection are MEDIUM with their own keys', () => {
    const out = run([w({ id: 'a', status: 'PARTIAL', submitted_date: ASOF, settled_cents: 27_000 }), w({ id: 'b', status: 'REJECTED', submitted_date: null })]);
    expect(out.map((x) => x.dedupKey)).toEqual(['DL-6:a:short_pay', 'DL-6:b:rejected']);
    expect(out[0].amountAtRiskCents).toBe(2_400);
  });
  it('rejection rate: needs at least 5 claims and more than 10%', () => {
    const recent = (n: number) => Array.from({ length: n }, (_, i) => w({ id: `r${i}`, status: 'PAID', submitted_date: '2026-10-01', settled_cents: 29_400 }));
    expect(run(recent(4), ['r0']).filter((x) => x.kind === 'rejection_rate')).toHaveLength(0);
    expect(run(recent(10), ['r0']).filter((x) => x.kind === 'rejection_rate')).toHaveLength(0); // exactly 10%
    const hit = run(recent(9), ['r0']).filter((x) => x.kind === 'rejection_rate');
    expect(hit.map((x) => x.dedupKey)).toEqual(['DL-6:rate:oem:2026-10']);
    expect(hit[0].title).toMatch(/^Warranty rejection rate high: Maker · 1 of 9 claims/);
  });
  const ic = (over: Partial<IncentiveClaimIn> = {}): IncentiveClaimIn => ({
    id: 'i1', program_id: 'p1', program_name: 'Fall rebate', claim_reference: null, status: 'ACCRUED', earned_date: '2026-09-01',
    claim_deadline: '2026-10-30', submitted_date: null, accrued_cents: 50_000, claimed_cents: 0, settled_cents: 0, written_off_cents: 0, ...over,
  });
  it('DL-7: accrued within the deadline window; submitted and unpaid beyond the aging days', () => {
    const run7 = (claims: IncentiveClaimIn[]) => incentiveFindings({ asOf: ASOF, deadlineWarnDays: 10, submittedAgingDays: 60, claims }).map((x) => x.dedupKey);
    expect(run7([ic()])).toEqual(['DL-7:i1:deadline']);
    expect(run7([ic({ claim_deadline: '2026-10-31' })])).toEqual([]);
    expect(run7([ic({ status: 'SUBMITTED', submitted_date: '2026-08-21', claimed_cents: 50_000 })])).toEqual([]); // 60 days
    expect(run7([ic({ status: 'SUBMITTED', submitted_date: '2026-08-20', claimed_cents: 50_000 })])).toEqual(['DL-7:i1:aging']);
    expect(run7([ic({ settled_cents: 50_000 })])).toEqual([]);
  });
});

describe('DL-8 lender statement variance', () => {
  const st = (over: Record<string, unknown> = {}) => ({ id: 's1', line_id: 'l1', line_name: 'Main line', kind: 'STATEMENT' as const, statement_date: '2026-10-15', status: 'MATCHING' as const, ...over });
  const line = (id: string, match_status: string, variance = 0, current: number | null = null) => ({ id, statement_id: 's1', match_status: match_status as 'VARIANCE', variance_cents: variance, current_cents: current });
  it('a variance beyond tolerance fires at once; at tolerance it does not', () => {
    expect(statementFindings({ asOf: ASOF, toleranceCents: 100, statements: [st()], lines: [line('a', 'VARIANCE', 101)] }).map((x) => x.dedupKey)).toEqual(['DL-8:s1']);
    expect(statementFindings({ asOf: ASOF, toleranceCents: 100, statements: [st()], lines: [line('a', 'VARIANCE', -100)] })).toHaveLength(0);
  });
  it('lender-only / Books-only lines wait for the month end of the statement date', () => {
    const lines = [line('a', 'LENDER_ONLY', 0, 50_000), line('b', 'BOOKS_ONLY', 70_000)];
    expect(statementFindings({ asOf: ASOF, toleranceCents: 100, statements: [st()], lines })).toHaveLength(0);
    const out = statementFindings({ asOf: '2026-10-31', toleranceCents: 100, statements: [st()], lines });
    expect(out[0].amountAtRiskCents).toBe(120_000);
    expect(out[0].severity).toBe('HIGH');
  });
  it('approved statements and payoff quotes never fire', () => {
    const lines = [line('a', 'VARIANCE', 5_000)];
    expect(statementFindings({ asOf: ASOF, toleranceCents: 100, statements: [st({ status: 'APPROVED' })], lines })).toHaveLength(0);
    expect(statementFindings({ asOf: ASOF, toleranceCents: 100, statements: [st({ kind: 'PAYOFF_QUOTE' })], lines })).toHaveLength(0);
  });
});

describe('DL-11 trade-in risk', () => {
  const sales = new Map([['s1', { id: 's1', sale_date: '2026-10-05', sale_price_cents: 1_000_000, status: 'POSTED', unit_serial: 'U1' }]]);
  const t = (over: Record<string, unknown> = {}) => ({ id: 't1', sale_id: 's1', serial_number: 'T1', model: null, status: 'POSTED', over_allowance_cents: 0, lien_payoff_cents: 0, lien_status: 'NONE', ...over });
  it('over-allowance at exactly the warning share fires; just under does not', () => {
    expect(tradeRiskFindings({ asOf: ASOF, overAllowanceWarnBps: 2000, lienUnpaidDays: 10, sales, trades: [t({ over_allowance_cents: 200_000 })] }).map((x) => x.dedupKey)).toEqual(['DL-11:t1:over_allowance']);
    expect(tradeRiskFindings({ asOf: ASOF, overAllowanceWarnBps: 2000, lienUnpaidDays: 10, sales, trades: [t({ over_allowance_cents: 199_900 })] })).toHaveLength(0);
  });
  it('a lien owed more than the allowed days after a posted sale fires', () => {
    const lien = t({ lien_payoff_cents: 300_000, lien_status: 'OWED' });
    expect(tradeRiskFindings({ asOf: '2026-10-15', overAllowanceWarnBps: 2000, lienUnpaidDays: 10, sales, trades: [lien] })).toHaveLength(0); // 10 days
    expect(tradeRiskFindings({ asOf: '2026-10-16', overAllowanceWarnBps: 2000, lienUnpaidDays: 10, sales, trades: [lien] }).map((x) => x.dedupKey)).toEqual(['DL-11:t1:lien']);
    expect(tradeRiskFindings({ asOf: ASOF, overAllowanceWarnBps: 2000, lienUnpaidDays: 10, sales, trades: [{ ...lien, lien_status: 'PAID' }] })).toHaveLength(0);
  });
});

describe('DL-13 double-recorded flooring', () => {
  const notes = [{ id: 'n1', unit_id: 'u1', lender_invoice_number: 'FP-778812', serial_number: 'SN4471X', original_principal_cents: 1_000_000, relatedVendorIds: ['oem', 'lender'] }];
  const bills = [
    { id: 'b1', vendor_id: 'oem', bill_number: 'OEM-1', status: 'PENDING' },
    { id: 'b2', vendor_id: 'carrier', bill_number: 'FRT-9', status: 'PENDING' },
    { id: 'b3', vendor_id: 'anyone', bill_number: 'fp 778812', status: 'APPROVED' },
    { id: 'b4', vendor_id: 'oem', bill_number: 'X', status: 'VOIDED' },
  ];
  const lines = [
    { id: 'l1', bill_id: 'b1', description: 'Unit sn-4471x base invoice', amount_cents: 1_000_000 },
    { id: 'l2', bill_id: 'b2', description: 'Freight for SN4471X', amount_cents: 25_000 },
    { id: 'l3', bill_id: 'b3', description: 'Invoice', amount_cents: 1_000_000 },
    { id: 'l4', bill_id: 'b4', description: 'SN4471X', amount_cents: 1_000_000 },
  ];
  it('serial on a manufacturer bill and the lender invoice # on any bill fire; freight and void bills do not', () => {
    const out = doubleFlooringFindings({ notes, bills, lines, linkedBillLineIds: new Set() });
    expect(out.map((x) => [x.dedupKey, x.kind])).toEqual([['DL-13:l1:n1', 'serial'], ['DL-13:l3:n1', 'invoice']]);
    expect(out.every((x) => x.severity === 'HIGH')).toBe(true);
    expect(out[0].href).toBe('/bills?id=b1');
  });
  it('a bill line already linked as a unit cost is legitimate; short tokens never match', () => {
    expect(doubleFlooringFindings({ notes, bills, lines, linkedBillLineIds: new Set(['l1', 'l3']) })).toHaveLength(0);
    const short = [{ ...notes[0], lender_invoice_number: '12', serial_number: 'AB1' }];
    expect(doubleFlooringFindings({ notes: short, bills, lines: [{ id: 'z', bill_id: 'b1', description: '12 AB1', amount_cents: 1 }], linkedBillLineIds: new Set() })).toHaveLength(0);
  });
});
