/**
 * Wave 4C cash forecast — pure engine tests (docs/FPB-reports-fpna.md §4.12, AC-CF1…AC-CF8, AC-CF10).
 * Fixed clock: today = 2026-10-21 (a Wednesday) → week 1 = Mon 2026-10-19 … Sun 2026-10-25.
 */
import { describe, expect, it } from 'vitest';
import { addDays, mondayOf, nextPayDate, payDatesAfter } from './dates';
import { buildPayProfiles, expectReceipt, profileFor, weightedMedian } from './receipt-timing';
import {
  apItems,
  arItems,
  debtItems,
  dropMatchedByBills,
  leasePaymentDate,
  leaseItems,
  manualItems,
  payrollItems,
  recurringArItems,
  salesTaxItems,
  subscriptionItems,
  type OpenInvoice,
  type Window,
} from './sources';
import { classifyFamily, computeRunRate, countedFromItems } from './runrate';
import { applyScenario, presetAdjustments } from './scenario';
import { buildCashForecast, forecastBridge, horizonEndOf, itemVariance, topItems } from './engine';
import { availableByCompany, availableLines, recommend } from './liquidity';
import { actualWeeks, computeAccuracy, mape, sumSnapshots, toSnapshotWeeks, weekAccuracy, type SnapshotRow } from './accuracy';
import { bankSeries, buildCashHistory, computeRunway, historyDates } from './history';
import { assembleItems, DEFAULT_SETTINGS, emptyInputs, type CompanyInput } from './assemble';
import { directionOf, type ForecastItem } from './types';

const TODAY = '2026-10-21';
const W: Window = { today: TODAY, horizonEnd: horizonEndOf(TODAY) };

function item(p: Partial<ForecastItem> & Pick<ForecastItem, 'key' | 'direction' | 'category' | 'date' | 'amountCents'>): ForecastItem {
  return {
    companyId: 'A',
    grossCents: p.amountCents,
    probability: 1,
    certainty: 'COMMITTED',
    label: p.key,
    party: null,
    partyId: null,
    source: { kind: 'MANUAL', id: null },
    ...p,
  };
}

describe('dates', () => {
  it('anchors week 1 on the Monday and the horizon on the 13th Sunday', () => {
    expect(mondayOf(TODAY)).toBe('2026-10-19');
    expect(W.horizonEnd).toBe('2027-01-17');
  });
  it('semimonthly pays on the 15th and the month end (AC-CF2)', () => {
    expect(nextPayDate('2026-10-15', 'SEMIMONTHLY')).toBe('2026-10-31');
    expect(nextPayDate('2026-10-31', 'SEMIMONTHLY')).toBe('2026-11-15');
    expect(nextPayDate('2026-02-15', 'SEMIMONTHLY')).toBe('2026-02-28');
    expect(payDatesAfter('2026-10-09', 'BIWEEKLY', '2026-11-30')).toEqual(['2026-10-23', '2026-11-06', '2026-11-20']);
    expect(nextPayDate('2026-01-31', 'MONTHLY', 31)).toBe('2026-02-28');
  });
});

describe('receipt timing (AC-CF1)', () => {
  const history = [
    { customerId: 'c1', dueDate: '2026-06-01', paidDate: '2026-06-11', amountCents: 50_000 },
    { customerId: 'c1', dueDate: '2026-07-01', paidDate: '2026-07-11', amountCents: 40_000 },
    { customerId: 'c1', dueDate: '2026-08-01', paidDate: '2026-08-31', amountCents: 5_000 },
    { customerId: 'c2', dueDate: '2026-06-01', paidDate: '2026-06-01', amountCents: 10_000 },
  ];
  it('weighted median ignores a small outlier', () => {
    expect(weightedMedian([{ value: 10, weight: 50 }, { value: 10, weight: 40 }, { value: 30, weight: 5 }])).toBe(10);
    expect(weightedMedian([])).toBeNull();
  });
  it('a customer who pays 10 days late is expected due + 10', () => {
    const p = buildPayProfiles(history);
    const prof = profileFor(p, 'c1');
    expect(prof).toMatchObject({ medianDaysLate: 10, basis: 'CUSTOMER' });
    const e = expectReceipt({ dueDate: '2026-11-02', balanceCents: 100_000, today: TODAY, profile: prof });
    expect(e.expectedDate).toBe('2026-11-12');
    expect(e.probability).toBe(0.98);
    expect(e.expectedCents).toBe(98_000);
    expect(e.atRiskCents).toBe(2_000);
  });
  it('no customer history → org profile; no org history → due date', () => {
    const p = buildPayProfiles(history);
    expect(profileFor(p, 'unknown').basis).toBe('ORG');
    expect(profileFor(buildPayProfiles([]), 'x')).toMatchObject({ basis: 'DUE_DATE', medianDaysLate: 0 });
  });
  it('disputed halves the probability; reliability lowers it; overdue beyond usual → within a week', () => {
    const p = buildPayProfiles(history, [
      { customerId: 'c1', outcome: 'PAID', cents: 80_000 },
      { customerId: 'c1', outcome: 'WRITTEN_OFF', cents: 20_000 },
    ]);
    const prof = profileFor(p, 'c1');
    expect(prof.reliability).toBe(0.8);
    const e = expectReceipt({ dueDate: '2026-09-01', balanceCents: 10_000, today: TODAY, profile: prof, disputed: true });
    // 50 days past due → 0.85 × 0.8 × 0.5
    expect(e.probability).toBeCloseTo(0.34, 6);
    expect(e.expectedDate).toBe(addDays(TODAY, 7));
    expect(e.expectedCents + e.atRiskCents).toBe(10_000);
  });
  it('arItems counts expected cents only and reports the at-risk remainder', () => {
    const invs: OpenInvoice[] = [
      { id: 'i1', companyId: 'A', number: '1001', customerId: 'c1', customerName: 'Acme', dueDate: '2026-11-02', balanceCents: 100_000, status: 'SENT', disputed: false },
    ];
    const r = arItems(invs, buildPayProfiles(history), W);
    expect(r.items[0]).toMatchObject({ key: 'ar:i1', date: '2026-11-12', amountCents: 98_000, grossCents: 100_000 });
    expect(r.atRiskCents).toBe(2_000);
  });
});

describe('schedules land in the right weeks (AC-CF2)', () => {
  it('biweekly payroll steps 14 days from the last run; a run on file replaces the projection', () => {
    const items = payrollItems(
      [{ id: 's1', companyId: 'A', name: 'Hourly', frequency: 'BIWEEKLY', anchorDate: null }],
      [
        { id: 'r1', scheduleId: 's1', companyId: 'A', payDate: '2026-09-25', status: 'PAID', grossCents: 100_000, netCents: 80_000, employerTaxCents: 7_650, employeeTaxCents: 20_000 },
        { id: 'r2', scheduleId: 's1', companyId: 'A', payDate: '2026-10-09', status: 'PAID', grossCents: 120_000, netCents: 96_000, employerTaxCents: 9_180, employeeTaxCents: 24_000 },
        { id: 'r3', scheduleId: 's1', companyId: 'A', payDate: '2026-10-23', status: 'APPROVED', grossCents: 110_000, netCents: 88_000, employerTaxCents: 8_415, employeeTaxCents: 22_000 },
      ],
      W,
    );
    const committed = items.filter((i) => i.source.kind === 'PAYROLL_RUN');
    expect(committed.map((i) => [i.date, i.category, i.amountCents])).toEqual([
      ['2026-10-23', 'PAYROLL', 88_000],
      ['2026-10-23', 'PAYROLL_TAX', 30_415],
    ]);
    const projected = items.filter((i) => i.projected);
    const dates = Array.from(new Set(projected.map((i) => i.date)));
    expect(dates[0]).toBe('2026-11-06');
    expect(dates.every((d, i) => i === 0 || addDays(dates[i - 1], 14) === d)).toBe(true);
    // Average of the last 3 completed (r3 is APPROVED, before today? no — its pay date is in the future so not "completed").
    const net = projected.find((i) => i.category === 'PAYROLL')!.amountCents;
    expect(net).toBe(Math.round((80_000 + 96_000) / 2));
    expect(projected.find((i) => i.category === 'PAYROLL_TAX')!.amountCents).toBe(Math.round((27_650 + 33_180) / 2));
  });
  it('employer tax from bps when runs carry none', () => {
    const items = payrollItems(
      [{ id: 's1', companyId: 'A', name: 'Salaried', frequency: 'MONTHLY', anchorDate: null }],
      [{ id: 'r1', scheduleId: 's1', companyId: 'A', payDate: '2026-09-30', status: 'PAID', grossCents: 100_000, netCents: 80_000, employerTaxCents: 0, employeeTaxCents: 20_000 }],
      W,
      { employerTaxBps: () => 765 },
    );
    expect(items[0].date).toBe('2026-10-30');
    expect(items.find((i) => i.category === 'PAYROLL_TAX')!.amountCents).toBe(27_650);
  });
  it('never invents a payroll size without history', () => {
    expect(payrollItems([{ id: 's', companyId: 'A', name: 'x', frequency: 'WEEKLY', anchorDate: '2026-10-02' }], [], W)).toEqual([]);
  });
  it('debt: posted periods are skipped; an overdue unposted line lands today', () => {
    const lines = [
      { instrumentId: 'd1', instrumentName: 'Term loan', lender: 'Bank', companyId: 'A', period: 9, date: '2026-10-01', paymentCents: 5_000, interestCents: 1_000, principalCents: 4_000 },
      { instrumentId: 'd1', instrumentName: 'Term loan', lender: 'Bank', companyId: 'A', period: 10, date: '2026-10-15', paymentCents: 5_000, interestCents: 990, principalCents: 4_010 },
      { instrumentId: 'd1', instrumentName: 'Term loan', lender: 'Bank', companyId: 'A', period: 11, date: '2026-11-15', paymentCents: 5_000, interestCents: 980, principalCents: 4_020 },
    ];
    const items = debtItems(lines, new Set(['debt:payment:d1:9']), W);
    expect(items.map((i) => [i.key, i.date])).toEqual([
      ['debt:d1:10', TODAY],
      ['debt:d1:11', '2026-11-15'],
    ]);
  });
  it('leases: ARREARS on the line date, ADVANCE on the first of the period', () => {
    expect(leasePaymentDate({ periodDate: '2026-11-30', frequency: 'MONTHLY', timing: 'ARREARS' })).toBe('2026-11-30');
    expect(leasePaymentDate({ periodDate: '2026-11-30', frequency: 'MONTHLY', timing: 'ADVANCE' })).toBe('2026-11-01');
    expect(leasePaymentDate({ periodDate: '2026-12-31', frequency: 'QUARTERLY', timing: 'ADVANCE' })).toBe('2026-10-01');
    const items = leaseItems(
      [{ leaseId: 'l1', lessor: 'Landlord', description: 'Office', companyId: 'A', period: 3, periodDate: '2026-11-30', paymentCents: 400_000, frequency: 'MONTHLY', timing: 'ADVANCE' }],
      W,
    );
    expect(items[0]).toMatchObject({ date: '2026-11-01', category: 'LEASE', amountCents: 400_000 });
  });
  it('subscriptions step by cadence from the next renewal', () => {
    const items = subscriptionItems(
      [{ id: 'sub', companyId: 'A', vendorId: 'v9', vendorName: 'SaaSCo', product: 'Pro', amountCents: 9_900, cadence: 'MONTHLY', nextRenewalDate: '2026-10-05', lastChargedDate: null, status: 'ACTIVE' }],
      W,
    );
    expect(items.map((i) => i.date)).toEqual(['2026-11-05', '2026-12-05', '2027-01-05']);
  });
  it('sales tax: next period from the filing calendar, mean of the last 3 remitted', () => {
    const items = salesTaxItems(
      [
        { jurisdiction: 'IA', frequency: 'monthly', periodEnd: '2026-09-30', dueDate: '2026-10-20', remittedCents: 3_000 },
        { jurisdiction: 'IA', frequency: 'monthly', periodEnd: '2026-08-31', dueDate: '2026-09-20', remittedCents: 2_000 },
        { jurisdiction: 'IA', frequency: 'monthly', periodEnd: '2026-07-31', dueDate: '2026-08-20', remittedCents: 1_000 },
      ],
      'A',
      W,
    );
    expect(items.map((i) => [i.date, i.amountCents])).toEqual([
      ['2026-11-20', 2_000],
      ['2026-12-20', 2_000],
    ]);
  });
  it('recurring billing: runs → due + terms, skipping runs already invoiced', () => {
    const items = recurringArItems(
      [{ id: 't1', companyId: 'A', name: 'Maintenance', customerId: 'c', customerName: 'C', frequency: 'MONTHLY', intervalCount: 1, nextRunDate: '2026-11-01', endDate: null, occurrencesRemaining: null, runAmountCents: 50_000, termsDays: 15, generatedRunDates: new Set(['2026-12-01']) }],
      buildPayProfiles([]),
      W,
    );
    expect(items.map((i) => i.date)).toEqual(['2026-11-16', '2027-01-16']);
    expect(items[0].amountCents).toBe(Math.round(50_000 * Math.round(0.98 * 0.97 * 10_000) / 10_000));
  });
  it('AP: scheduled → scheduled date (committed); pay-run → pay-by; overdue → today; unapproved excluded on request', () => {
    const bills = [
      { id: 'b1', companyId: 'A', number: '1', vendorId: 'v', vendorName: 'V', dueDate: '2026-11-30', balanceCents: 1_000, status: 'SCHEDULED', scheduledPaymentDate: '2026-11-05' },
      { id: 'b2', companyId: 'A', number: '2', vendorId: 'v', vendorName: 'V', dueDate: '2026-11-30', balanceCents: 1_000, status: 'APPROVED', scheduledPaymentDate: null, payRunDate: '2026-10-26' },
      { id: 'b3', companyId: 'A', number: '3', vendorId: 'v', vendorName: 'V', dueDate: '2026-09-30', balanceCents: 1_000, status: 'APPROVED', scheduledPaymentDate: null },
      { id: 'b4', companyId: 'A', number: '4', vendorId: 'v', vendorName: 'V', dueDate: '2026-11-10', balanceCents: 1_000, status: 'PENDING', scheduledPaymentDate: null },
    ];
    const items = apItems(bills, W, { includeUnapproved: false });
    expect(items.map((i) => [i.key, i.date, i.certainty])).toEqual([
      ['ap:b1', '2026-11-05', 'COMMITTED'],
      ['ap:b2', '2026-10-26', 'EXPECTED'],
      ['ap:b3', TODAY, 'EXPECTED'],
    ]);
  });
  it('manual items recur monthly and respect probability', () => {
    const items = manualItems(
      [{ id: 'm1', companyId: 'A', scenarioId: null, direction: 'OUT', category: 'CAPEX', label: 'Truck', expectedDate: '2026-11-10', amountCents: 10_000, probabilityBps: 5_000, recurrence: 'MONTHLY', recurrenceEnd: '2026-12-31', counterpartyCompanyId: null, accountId: null, note: null }],
      W,
      null,
    );
    expect(items.map((i) => [i.date, i.amountCents])).toEqual([
      ['2026-11-10', 5_000],
      ['2026-12-10', 5_000],
    ]);
    // A scenario-only item is excluded from other scenarios.
    expect(manualItems([{ id: 'm2', companyId: 'A', scenarioId: 'S1', direction: 'IN', category: 'OTHER_IN', label: 'x', expectedDate: '2026-11-01', amountCents: 1, probabilityBps: 10_000, recurrence: 'NONE', recurrenceEnd: null, counterpartyCompanyId: null, accountId: null, note: null }], W, null)).toEqual([]);
  });
});

describe('no double counting (AC-CF3)', () => {
  it('run-rate = budget − bills coded to the account that month; payroll / non-cash excluded', () => {
    const families = new Map([
      ['util', classifyFamily({ name: 'Utilities' })],
      ['wages', classifyFamily({ name: 'Field wages' })],
      ['dep', classifyFamily({ name: 'Depreciation expense' })],
    ]);
    expect(families.get('util')).toBe('OTHER');
    expect(families.get('wages')).toBe('PAYROLL');
    expect(families.get('dep')).toBe('NON_CASH');
    const bill = apItems(
      [{ id: 'b', companyId: 'A', number: '1', vendorId: 'v', vendorName: 'Power', dueDate: '2026-11-20', balanceCents: 400_000, status: 'APPROVED', scheduledPaymentDate: null, lines: [{ accountId: 'util', amountCents: 400_000 }] }],
      W,
    );
    const rr = computeRunRate({
      basis: [
        { companyId: 'A', accountId: 'util', month: '2026-11', cents: 1_000_000 },
        { companyId: 'A', accountId: 'wages', month: '2026-11', cents: 5_000_000 },
        { companyId: 'A', accountId: 'dep', month: '2026-11', cents: 200_000 },
      ],
      counted: countedFromItems(bill),
      families,
      coveredFamilies: () => new Set(['PAYROLL']),
      today: TODAY,
      horizonEnd: W.horizonEnd,
      basisLabel: 'Budget',
    });
    const nov = rr.months.find((m) => m.month === '2026-11')!;
    expect(nov.runRateCents).toBe(600_000);
    expect(nov.excludedCents).toBe(5_200_000);
    expect(nov.countedCents).toBe(400_000);
    // November lies fully inside the horizon → all of it is spread over its days, and ties.
    const total = rr.items.reduce((s, i) => s + i.amountCents, 0);
    expect(total).toBe(nov.inHorizonCents);
    expect(nov.inHorizonCents).toBe(600_000);
  });
  it('the current month is prorated from today', () => {
    const rr = computeRunRate({
      basis: [{ companyId: 'A', accountId: 'util', month: '2026-10', cents: 310_000 }],
      counted: [],
      families: new Map([['util', 'OTHER']]),
      coveredFamilies: () => new Set(),
      today: TODAY,
      horizonEnd: W.horizonEnd,
      basisLabel: 'Budget',
    });
    // Oct 21–31 = 11 of 31 days.
    expect(rr.months[0].inHorizonCents).toBe(110_000);
    expect(rr.items.reduce((s, i) => s + i.amountCents, 0)).toBe(110_000);
  });
  it('a subscription matched by an open bill to the same vendor is dropped', () => {
    const sub = item({ key: 'subscription:s', direction: 'OUT', category: 'SUBSCRIPTION', date: '2026-11-05', amountCents: 9_900, partyId: 'v9', party: 'SaaSCo' });
    const bill = item({ key: 'ap:b', direction: 'OUT', category: 'AP', date: '2026-11-08', amountCents: 10_000, partyId: 'v9', party: 'SaaSCo, Inc.' });
    const r = dropMatchedByBills([sub], [bill]);
    expect(r.dropped).toHaveLength(1);
    expect(dropMatchedByBills([{ ...sub, amountCents: 20_000, grossCents: 20_000 }], [bill]).dropped).toHaveLength(0);
  });
  it('assemble: payroll accounts contribute nothing to the run-rate when a pay schedule is active', () => {
    const companies: CompanyInput[] = [{ id: 'A', name: 'Alpha', settings: { ...DEFAULT_SETTINGS } }];
    const inp = emptyInputs(companies);
    inp.schedules = [{ id: 's1', companyId: 'A', name: 'x', frequency: 'MONTHLY', anchorDate: null }];
    inp.runRateBasis = [
      { companyId: 'A', accountId: 'wages', month: '2026-11', cents: 900_000 },
      { companyId: 'A', accountId: 'rent', month: '2026-11', cents: 300_000 },
    ];
    inp.accountFamilies = new Map([
      ['wages', 'PAYROLL'],
      ['rent', 'RENT_LEASE'],
    ]);
    const r = assembleItems(inp, W, null);
    // rent stays (no lease on file); wages excluded.
    expect(r.items.filter((i) => i.category === 'OPEX_RUNRATE').reduce((s, i) => s + i.amountCents, 0)).toBe(300_000);
  });
});

describe('engine ties and intercompany (AC-CF4, AC-CF6)', () => {
  const items: ForecastItem[] = [
    item({ key: 'in1', direction: 'IN', category: 'AR', date: '2026-10-22', amountCents: 50_000 }),
    item({ key: 'out1', direction: 'OUT', category: 'AP', date: '2026-10-30', amountCents: 20_000 }),
    item({ key: 'ic', direction: 'IN', category: 'AR', date: '2026-11-03', amountCents: 7_000, counterpartyCompanyId: 'B' }),
    item({ key: 'b-out', companyId: 'B', direction: 'OUT', category: 'PAYROLL', date: '2026-11-03', amountCents: 30_000 }),
    item({ key: 'org', companyId: null, direction: 'OUT', category: 'TAX', date: '2026-11-20', amountCents: 1_000 }),
    item({ key: 'late', direction: 'IN', category: 'AR', date: '2027-03-01', amountCents: 9_999 }),
  ];
  const f = buildCashForecast({
    today: TODAY,
    companies: [
      { id: 'A', name: 'Alpha', openingCents: 100_000, minimumCents: 0 },
      { id: 'B', name: 'Beta', openingCents: 40_000, minimumCents: 20_000 },
    ],
    items,
  });
  it('every scope: opening + in − out = closing; weeks chain; days tie to weeks', () => {
    for (const s of [f.combined, ...f.companies]) {
      let prev = s.openingCents;
      for (const w of s.weeks) {
        expect(w.openingCents).toBe(prev);
        expect(w.openingCents + w.inflowsCents - w.outflowsCents).toBe(w.closingCents);
        prev = w.closingCents;
        const days = s.days.filter((d) => d.date >= w.start && d.date <= w.end);
        expect(days.reduce((x, d) => x + d.inflowsCents - d.outflowsCents, 0)).toBe(w.netCents);
      }
      expect(s.closingCents).toBe(prev);
      expect(s.days[s.days.length - 1].closingCents).toBe(s.closingCents);
    }
  });
  it('intercompany receivable counts for the company, not the group; org-level items only in combined', () => {
    const a = f.companies.find((c) => c.scopeId === 'A')!;
    expect(a.totals.inflowsCents).toBe(57_000);
    expect(f.combined.totals.inflowsCents).toBe(50_000);
    expect(f.combinedExcludedKeys).toEqual(['ic']);
    expect(f.intercompanyExcluded).toEqual({ count: 1, inflowsCents: 7_000, outflowsCents: 0 });
    const sumCompanies = f.companies.reduce((s, c) => s + c.totals.netCents, 0);
    expect(f.combined.totals.netCents).toBe(sumCompanies - 7_000 - 1_000);
    expect(f.beyondHorizon.inflowsCents).toBe(9_999);
  });
  it('week 1 starts Monday; today carries the opening; minimum breach found', () => {
    expect(f.combined.weeks[0].start).toBe('2026-10-19');
    expect(f.combined.days[0].date).toBe(TODAY);
    const b = f.companies.find((c) => c.scopeId === 'B')!;
    expect(b.firstBreach).toMatchObject({ weekIndex: 2, shortfallCents: 10_000 });
  });
  it('band widens with uncertainty and is zero for committed items', () => {
    expect(f.combined.weeks[0].hiCents).toBe(f.combined.weeks[0].closingCents);
    expect(itemVariance(item({ key: 'x', direction: 'IN', category: 'AR', date: TODAY, amountCents: 50, grossCents: 100, probability: 0.5, certainty: 'EXPECTED' }))).toBe(2_500);
    const g = buildCashForecast({ today: TODAY, companies: [{ id: 'A', name: 'A', openingCents: 0, minimumCents: 0 }], items: [item({ key: 'e', direction: 'OUT', category: 'OPEX_RUNRATE', date: TODAY, amountCents: 10_000, certainty: 'ESTIMATED' })] });
    expect(g.combined.weeks[0].hiCents - g.combined.weeks[0].closingCents).toBe(Math.round(1.2816 * 1_000));
  });
  it('bridge from opening to closing ties; top items sorted', () => {
    const steps = forecastBridge(f.combined);
    const sum = steps.filter((s) => s.kind === 'delta').reduce((x, s) => x + s.value, steps[0].value);
    expect(sum).toBe(steps[steps.length - 1].value);
    expect(topItems(f, 'combined', 'OUT', 2).map((i) => i.key)).toEqual(['b-out', 'out1']);
    expect(directionOf('LINE_DRAW')).toBe('IN');
  });
});

describe('scenario math (AC-CF5)', () => {
  const base: ForecastItem[] = [
    item({ key: 'ar1', direction: 'IN', category: 'AR', date: '2026-11-02', amountCents: 10_001, partyId: 'c1' }),
    item({ key: 'ar2', direction: 'IN', category: 'AR', date: '2026-11-02', amountCents: 5_000, partyId: 'c2' }),
    item({ key: 'pr', direction: 'OUT', category: 'PAYROLL', date: '2026-11-06', amountCents: 20_000, projected: true }),
    item({ key: 'pr-run', direction: 'OUT', category: 'PAYROLL', date: '2026-10-23', amountCents: 20_000 }),
    item({ key: 'ap1', direction: 'OUT', category: 'AP', date: '2026-10-22', amountCents: 3_000, partyId: 'v1' }),
  ];
  it('delays only the targeted customer, haircuts per item, grows projected payroll only, removes one item', () => {
    const r = applyScenario(
      base,
      [
        { id: 'a', kind: 'DELAY_RECEIPTS', companyId: null, customerId: 'c1', days: 14 },
        { id: 'b', kind: 'RECEIPT_HAIRCUT', companyId: null, bps: 1000 },
        { id: 'c', kind: 'PAYROLL_GROWTH', companyId: null, bps: 500 },
        { id: 'd', kind: 'REMOVE_ITEM', companyId: null, itemKey: 'ap1' },
        { id: 'e', kind: 'DELAY_DISBURSEMENTS', companyId: null, vendorId: 'nobody', days: 10 },
      ],
      TODAY,
    );
    const by = new Map(r.items.map((i) => [i.key, i]));
    expect(by.get('ar1')!.date).toBe('2026-11-16');
    expect(by.get('ar2')!.date).toBe('2026-11-02');
    expect(by.get('ar1')!.amountCents).toBe(Math.round(10_001 * 0.9));
    expect(by.get('ar2')!.amountCents).toBe(4_500);
    expect(by.get('pr')!.amountCents).toBe(21_000);
    expect(by.get('pr-run')!.amountCents).toBe(20_000);
    expect(by.has('ap1')).toBe(false);
    expect(r.touched.get('e')).toBeUndefined();
    // The base list is untouched.
    expect(base[0].date).toBe('2026-11-02');
    expect(base[0].amountCents).toBe(10_001);
  });
  it('acceleration clamps to today; line draws add an item and move headroom', () => {
    const r = applyScenario(base, [
      { id: 'x', kind: 'DELAY_RECEIPTS', companyId: null, days: -30 },
      { id: 'y', kind: 'LINE_DRAW', companyId: 'A', amountCents: 50_000, effectiveDate: '2026-11-01' },
    ], TODAY);
    expect(r.items.find((i) => i.key === 'ar1')!.date).toBe(TODAY);
    expect(r.items.find((i) => i.key === 'scenario:y')).toMatchObject({ direction: 'IN', category: 'LINE_DRAW', amountCents: 50_000 });
    expect(r.lineMovement.get('A')).toBe(50_000);
  });
  it('presets', () => {
    expect(presetAdjustments('DOWNSIDE').map((a) => a.kind)).toEqual(['DELAY_RECEIPTS', 'RECEIPT_HAIRCUT', 'PAYROLL_GROWTH']);
    expect(presetAdjustments('CUSTOM')).toEqual([]);
  });
});

describe('liquidity and minimum cash (AC-CF8)', () => {
  it('available = min(commitment, borrowing base) − drawn; bank feed then debt register fallbacks', () => {
    const lines = availableLines(
      [{ id: 'l', companyId: 'A', name: 'Revolver', commitmentCents: 1_000_000, borrowingBaseCents: 600_000, drawnCents: 100_000, instrumentId: 'd1', asOfDate: null }],
      [{ id: 'bk', companyId: 'B', name: 'LOC', availableCents: 250_000, currentCents: -50_000 }],
      [
        { id: 'd1', companyId: 'A', name: 'Rev', originalCents: 1_000_000, currentBalanceCents: 100_000 },
        { id: 'd2', companyId: 'C', name: 'LOC C', originalCents: 300_000, currentBalanceCents: 120_000 },
      ],
    );
    expect(lines.map((l) => [l.companyId, l.availableCents, l.source])).toEqual([
      ['A', 500_000, 'CONFIGURED'],
      ['B', 250_000, 'BANK_FEED'],
      ['C', 180_000, 'DEBT_REGISTER'],
    ]);
    expect(availableByCompany(lines, new Map([['A', 50_000]])).get('A')).toBe(450_000);
  });
  it('transfers never take a donor below its own minimum; then the line; then uncovered', () => {
    const f = buildCashForecast({
      today: TODAY,
      companies: [
        { id: 'A', name: 'Alpha', openingCents: 50_000, minimumCents: 100_000 },
        { id: 'B', name: 'Beta', openingCents: 300_000, minimumCents: 250_000 },
        { id: 'C', name: 'Gamma', openingCents: 90_000, minimumCents: 0 },
      ],
      items: [item({ key: 'c-out', companyId: 'C', direction: 'OUT', category: 'AP', date: '2026-11-02', amountCents: 80_000 })],
    });
    const recs = recommend(f.companies, new Map([['A', 30_000]]));
    expect(recs).toHaveLength(1);
    const r = recs[0];
    expect(r.shortfallCents).toBe(50_000);
    // Beta has 50,000 above its minimum; Gamma's low point is 10,000 above its 0 minimum.
    expect(r.transfers).toEqual([{ fromCompanyId: 'B', fromName: 'Beta', cents: 50_000, byDate: r.firstBreachDate }]);
    expect(r.lineDrawCents).toBe(0);
    expect(r.uncoveredCents).toBe(0);
    const tight = recommend(f.companies.map((c) => (c.scopeId === 'B' ? { ...c, minimumCents: 290_000 } : c)), new Map([['A', 15_000]]));
    expect(tight[0].transfers.map((t) => [t.fromCompanyId, t.cents])).toEqual([
      ['B', 10_000],
      ['C', 10_000],
    ]);
    expect(tight[0].lineDrawCents).toBe(15_000);
    expect(tight[0].uncoveredCents).toBe(15_000);
  });
});

describe('accuracy (AC-CF7)', () => {
  it('week accuracy 1 − |A−F|/|A|; zero actual is n/m; MAPE averages', () => {
    expect(weekAccuracy(8_000, 10_000)).toBe(0.75);
    expect(weekAccuracy(0, 10_000)).toBeNull();
    expect(mape([{ actual: 100, forecast: 80 }, { actual: 200, forecast: 260 }, { actual: 0, forecast: 5 }])).toBeCloseTo(0.25, 10);
  });
  it('actual weeks remove cash-to-cash transfers and group by source module', () => {
    const wk = '2026-10-12';
    const a = actualWeeks(
      [
        { entryId: 'e1', entryDate: '2026-10-13', sourceModule: 'AR', companyId: 'A', debitCents: 8_000, creditCents: 0 },
        { entryId: 'e2', entryDate: '2026-10-14', sourceModule: 'BILL', companyId: 'A', debitCents: 0, creditCents: 3_000 },
        { entryId: 'e3', entryDate: '2026-10-14', sourceModule: 'MANUAL', companyId: 'A', debitCents: 5_000, creditCents: 0 },
        { entryId: 'e3', entryDate: '2026-10-14', sourceModule: 'MANUAL', companyId: 'A', debitCents: 0, creditCents: 5_000 },
      ],
      [wk],
    ).get(wk)!;
    expect(a.inflowsCents).toBe(8_000);
    expect(a.outflowsCents).toBe(3_000);
    expect(a.byGroup).toEqual({ COLLECTIONS: 8_000, VENDOR_PAYMENTS: 3_000 });
  });
  it('lead-1 snapshot scored against the week; trend over a 4-week window', () => {
    const snaps: SnapshotRow[] = [
      { anchorDate: '2026-10-05', companyId: null, openingCents: 0, weeks: [{ start: '2026-10-05', inflows: { AR: 10_000 }, outflows: { AP: 4_000 }, closing: 6_000 }] },
      { anchorDate: '2026-10-12', companyId: null, openingCents: 0, weeks: [{ start: '2026-10-12', inflows: { AR: 10_000 }, outflows: { AP: 2_000 }, closing: 8_000 }] },
    ];
    const actual = new Map([
      ['2026-10-05', { start: '2026-10-05', inflowsCents: 8_000, outflowsCents: 4_000, byGroup: { COLLECTIONS: 8_000, VENDOR_PAYMENTS: 4_000 } }],
      ['2026-10-12', { start: '2026-10-12', inflowsCents: 10_000, outflowsCents: 4_000, byGroup: { COLLECTIONS: 10_000, VENDOR_PAYMENTS: 4_000 } }],
    ]);
    const r = computeAccuracy(snaps, actual, ['2026-09-28', '2026-10-05', '2026-10-12'], null, 1);
    expect(r.weeks[0].forecastInflows).toBeNull();
    expect(r.weeks[1].inflowAccuracy).toBe(0.75);
    expect(r.weeks[2].outflowAccuracy).toBe(0.5);
    expect(r.inflowMape).toBeCloseTo(0.125, 10);
    expect(r.outflowMape).toBeCloseTo(0.25, 10);
    expect(r.accuracy).toBeCloseTo(1 - 0.1875, 10);
    expect(r.trend[2].accuracy).toBeCloseTo(r.accuracy!, 10);
    expect(r.snapshotsOnFile).toBe(2);
  });
  it('a multi-company scope scores against the sum of its companies’ snapshots', () => {
    const rows: SnapshotRow[] = [
      { anchorDate: '2026-10-12', companyId: 'A', openingCents: 10, weeks: [{ start: '2026-10-12', inflows: { AR: 100 }, outflows: { AP: 40 }, closing: 70 }] },
      { anchorDate: '2026-10-12', companyId: 'B', openingCents: 5, weeks: [{ start: '2026-10-12', inflows: { AR: 50, DEPOSIT: 5 }, outflows: {}, closing: 60 }] },
      { anchorDate: '2026-10-12', companyId: 'C', openingCents: 999, weeks: [{ start: '2026-10-12', inflows: { AR: 999 }, outflows: {}, closing: 0 }] },
      { anchorDate: '2026-10-12', companyId: null, openingCents: 1, weeks: [] },
    ];
    expect(sumSnapshots(rows, ['A', 'B'])).toEqual([
      { anchorDate: '2026-10-12', companyId: null, openingCents: 15, weeks: [{ start: '2026-10-12', inflows: { AR: 150, DEPOSIT: 5 }, outflows: { AP: 40 }, closing: 130 }] },
    ]);
  });
  it('snapshot payload splits categories by direction', () => {
    const s = toSnapshotWeeks([{ start: 'w', byCategory: { AR: 5, AP: 3 }, closingCents: 2 }], (c) => directionOf(c) === 'IN');
    expect(s).toEqual([{ start: 'w', inflows: { AR: 5 }, outflows: { AP: 3 }, closing: 2 }]);
  });
});

describe('history and runway (AC-CF10)', () => {
  it('book cash per date from the GL; bank rewound from the feed; difference per point', () => {
    const cashIds = new Set(['cash']);
    const lines = [
      { accountId: 'cash', locationId: 'A', entryDate: '2026-10-01', debitCents: 100_000, creditCents: 0 },
      { accountId: 'cash', locationId: 'A', entryDate: '2026-10-15', debitCents: 0, creditCents: 30_000 },
      { accountId: 'other', locationId: 'A', entryDate: '2026-10-15', debitCents: 30_000, creditCents: 0 },
    ];
    const h = buildCashHistory({
      lines,
      cashIds,
      dates: ['2026-10-10', '2026-10-20'],
      bankCurrentCents: 75_000,
      bankTxns: [{ date: '2026-10-16', amountCents: -25_000 }],
    });
    expect(h.points).toEqual([
      { date: '2026-10-10', bookCents: 100_000, bankCents: 100_000, diffCents: 0 },
      { date: '2026-10-20', bookCents: 70_000, bankCents: 75_000, diffCents: -5_000 },
    ]);
    expect(bankSeries(null, [], ['x'])).toEqual([null]);
    const withheld = buildCashHistory({ lines, cashIds, dates: ['2026-10-10'], bankCurrentCents: null, bankTxns: [], shown: () => false });
    expect(withheld.points[0].bookCents).toBeNull();
  });
  it('history dates end today', () => {
    expect(historyDates(TODAY, 'day', 3)).toEqual(['2026-10-19', '2026-10-20', TODAY]);
    expect(historyDates(TODAY, 'week', 3)).toEqual(['2026-10-11', '2026-10-18', TODAY]);
    expect(historyDates(TODAY, 'month', 3)).toEqual(['2026-08-31', '2026-09-30', TODAY]);
  });
  it('runway at trailing and forecast burn; cash-generative never negative', () => {
    const r = computeRunway({ cashCents: 600_000, monthEnds: [900_000, 800_000, 700_000, 600_000], forecastNetCents: -300_000, availableLinesCents: 100_000, zeroCashDate: null });
    expect(r.trailingBurnCents).toBe(100_000);
    expect(r.trailingRunwayMonths).toBe(6);
    expect(r.forecastBurnCents).toBe(100_000);
    expect(r.liquidityCents).toBe(700_000);
    const g = computeRunway({ cashCents: 600_000, monthEnds: [500_000, 600_000], forecastNetCents: 10_000, availableLinesCents: 0, zeroCashDate: null });
    expect(g.trailingState).toBe('GENERATING');
    expect(g.trailingRunwayMonths).toBeNull();
    expect(g.forecastRunwayMonths).toBeNull();
    expect(computeRunway({ cashCents: 1, monthEnds: [null, 1], forecastNetCents: 0, availableLinesCents: 0, zeroCashDate: null }).trailingState).toBe('NOT_ENOUGH_HISTORY');
  });
});

describe('client scope and governance at the engine seam', () => {
  it('items of companies outside the scope never reach any view (combined included)', () => {
    const f = buildCashForecast({
      today: TODAY,
      companies: [{ id: 'A', name: 'Alpha', openingCents: 0, minimumCents: 0 }],
      items: [
        item({ key: 'mine', direction: 'IN', category: 'AR', date: '2026-10-22', amountCents: 100 }),
        item({ key: 'theirs', companyId: 'Z', direction: 'IN', category: 'AR', date: '2026-10-22', amountCents: 9_999 }),
      ],
    });
    expect(f.items.map((i) => i.key)).toEqual(['mine']);
    expect(f.combined.totals.inflowsCents).toBe(100);
    expect(f.companies.map((c) => c.scopeId)).toEqual(['A']);
  });

  it('assemble honours per-company settings: unapproved bills left out; run-rate OFF', () => {
    const companies: CompanyInput[] = [{ id: 'A', name: 'Alpha', settings: { ...DEFAULT_SETTINGS, includeUnapprovedBills: false, runrateBasis: 'OFF' } }];
    const inp = emptyInputs(companies);
    inp.bills = [
      { id: 'b1', companyId: 'A', number: '1', vendorId: 'v', vendorName: 'V', dueDate: '2026-11-02', balanceCents: 500, status: 'PENDING', scheduledPaymentDate: null },
      { id: 'b2', companyId: 'A', number: '2', vendorId: 'v', vendorName: 'V', dueDate: '2026-11-02', balanceCents: 700, status: 'APPROVED', scheduledPaymentDate: null },
    ];
    inp.runRateBasis = [{ companyId: 'A', accountId: 'util', month: '2026-11', cents: 100_000 }];
    const r = assembleItems(inp, W, null);
    expect(r.items.map((i) => i.key)).toEqual(['ap:b2']);
  });

  it('a bill from a vendor named like another company in scope is intercompany', () => {
    const companies: CompanyInput[] = [
      { id: 'A', name: 'Alpha Heating, LLC', settings: { ...DEFAULT_SETTINGS } },
      { id: 'B', name: 'Beta Cabinets', settings: { ...DEFAULT_SETTINGS } },
    ];
    const inp = emptyInputs(companies);
    inp.bills = [{ id: 'b', companyId: 'A', number: '1', vendorId: 'v', vendorName: 'Beta Cabinets Inc.', dueDate: '2026-11-02', balanceCents: 500, status: 'APPROVED', scheduledPaymentDate: null }];
    const r = assembleItems(inp, W, null);
    expect(r.items[0].counterpartyCompanyId).toBe('B');
    const f = buildCashForecast({ today: TODAY, companies: companies.map((c) => ({ id: c.id, name: c.name, openingCents: 0, minimumCents: 0 })), items: r.items });
    expect(f.companies.find((c) => c.scopeId === 'A')!.totals.outflowsCents).toBe(500);
    expect(f.combined.totals.outflowsCents).toBe(0);
  });

  it('a non-finance reader without the current month released starts from the bank feed (cash accounts only)', async () => {
    const { positionsFrom } = await import('./service');
    const companies: CompanyInput[] = [{ id: 'A', name: 'Alpha', settings: { ...DEFAULT_SETTINGS, minimumCashCents: 1_000 } }];
    const cash = { cashIds: new Set(['cash']), lines: [{ accountId: 'cash', locationId: 'A', companyId: 'A', entryId: 'e', entryDate: '2026-10-01', sourceModule: 'AR', debitCents: 50_000, creditCents: 0 }] };
    const banks = [
      { id: 'k1', companyId: 'A', name: 'Checking', institution: null, mask: '1', type: 'CHECKING', currentCents: 48_000, availableCents: 48_000, updatedAt: '2026-10-21T08:00:00Z' },
      { id: 'k2', companyId: 'A', name: 'Card', institution: null, mask: '2', type: 'CREDIT_CARD', currentCents: -9_000, availableCents: 1_000, updatedAt: null },
      { id: 'k3', companyId: 'A', name: 'LOC', institution: null, mask: '3', type: 'LINE_OF_CREDIT', currentCents: -20_000, availableCents: 80_000, updatedAt: '2026-10-21T08:00:00Z' },
    ];
    const now = new Date('2026-10-21T12:00:00Z');
    const [book] = positionsFrom(companies, cash, banks, TODAY, 'BOOK', now);
    expect(book).toMatchObject({ bookCents: 50_000, bankCents: 48_000, unreconciledCents: 2_000, openingCents: 50_000, staleCount: 1 });
    const [feed] = positionsFrom(companies, cash, banks, TODAY, 'BANK_FEED', now);
    expect(feed.openingCents).toBe(48_000);
    expect(feed.openingBasis).toBe('BANK_FEED');
  });
});
