/**
 * Parity tests for the client mirrors of the 1109 dealer arithmetic (src/lib/pm/dealer/math.ts):
 * pm.dealer_deal_totals, pm.rental_charge, pm.dealer_rental_rate, the DEALER_RO_CLOSED pay-type
 * split, pm.resolve_part supersession and the counter-ticket totals. Expected values are worked
 * by hand from the SQL; a guard reads 1109 so a change to the SQL constants fails here too.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agingBucket, belowMarginFloor, chargeWords, computeDealTotals, counterLookup, fillPlan, isAged, lineAmountCents,
  overAllowanceCents, parseCounterEntry, parseRange, paySplit, pgRound, pickRentalRate, rentalCharge, splitTotal,
  ticketTotals, utilization, walkSupersession, type CounterMatch, type CounterPart, type SplitLine, type TotalsInput,
} from '@/lib/pm/dealer/math';
import type { RentalRateRow } from '@/lib/pm/dealer/types';

const sql1109 = readFileSync(resolve(__dirname, '../../../../packages/supabase/migrations/1109_pm_dealer.sql'), 'utf8');

// ---------------------------------------------------------------- rounding
describe('Postgres rounding', () => {
  it('rounds qty × price half away from zero, without float error', () => {
    expect(lineAmountCents(1.5, 3333)).toBe(5000); // 4999.5
    expect(lineAmountCents(-1.5, 3333)).toBe(-5000);
    expect(lineAmountCents(1.0005, 3)).toBe(3); // 3.0015
    expect(lineAmountCents(0.3333, 300)).toBe(100); // 99.99
    expect(lineAmountCents(3, 0.1 * 3 * 10)).toBe(9); // 3 × 3
    expect(pgRound(2.5)).toBe(3);
    expect(pgRound(-2.5)).toBe(-3);
  });
});

// ---------------------------------------------------------------- deal totals
const deal = (over: Partial<TotalsInput> = {}): TotalsInput => ({
  lines: [
    { line_type: 'UNIT', amount_cents: 4_000_000, cost_cents: 3_400_000, taxable: true },
    { line_type: 'ATTACHMENT', amount_cents: 350_000, cost_cents: 280_000, taxable: true },
    { line_type: 'DISCOUNT', amount_cents: 100_000, cost_cents: 0, taxable: true },
    { line_type: 'FEE', amount_cents: 25_000, cost_cents: 0, taxable: true },
    { line_type: 'REBATE', amount_cents: 50_000, cost_cents: 0, taxable: false },
    { line_type: 'INCENTIVE', amount_cents: 75_000, cost_cents: 0, taxable: false },
  ],
  trades: [
    { status: 'APPRAISED', acv_cents: 800_000, allowance_cents: 900_000, payoff_cents: 200_000 },
    { status: 'VOID', acv_cents: 100_000, allowance_cents: 500_000, payoff_cents: 0 },
  ],
  fi: [{ price_cents: 150_000, cost_cents: 60_000 }],
  deposits: [
    { status: 'ISSUED', amount_cents: 100_000 },
    { status: 'REQUESTED', amount_cents: 25_000 },
    { status: 'REJECTED', amount_cents: 50_000 },
    { status: 'VOID', amount_cents: 70_000 },
  ],
  finance_reserve_cents: 40_000,
  subvention_cents: 10_000,
  tax_rate_estimate: 0.07,
  tax_exempt: false,
  trade_reduces_taxable: true,
  ...over,
});

describe('deal totals (pm.dealer_deal_totals)', () => {
  it('front, back, tax, cash price and balance for a compact tractor deal with a trade', () => {
    const t = computeDealTotals(deal());
    expect(t.unit_count).toBe(1);
    expect(t.merchandise_cents).toBe(4_350_000);
    expect(t.sale_price_cents).toBe(4_250_000);
    expect(t.unit_cost_cents).toBe(3_680_000);
    expect(t.trade_count).toBe(1); // VOID trade ignored
    expect(t.trade_allowance_cents).toBe(900_000);
    expect(t.over_allowance_cents).toBe(100_000);
    // sale − cost − over-allowance + fees − fee cost + incentives
    expect(t.front_gross_cents).toBe(570_000);
    // F&I price − cost + reserve − subvention
    expect(t.back_gross_cents).toBe(120_000);
    expect(t.total_gross_cents).toBe(690_000);
    expect(t.front_gross_pct).toBe(0.1341);
    // (4,375,000 taxable − 100,000 taxable discount − 900,000 trade allowance) × 7%
    expect(t.taxable_estimate_cents).toBe(3_375_000);
    expect(t.tax_estimate_cents).toBe(236_250);
    expect(t.deposits_cents).toBe(125_000); // REQUESTED + ISSUED, not REJECTED / VOID
    expect(t.cash_price_cents).toBe(4_611_250);
    expect(t.balance_due_estimate_cents).toBe(3_786_250);
  });

  it('a state that does not credit the trade taxes the full amount; exempt pays none', () => {
    expect(computeDealTotals(deal({ trade_reduces_taxable: false })).tax_estimate_cents).toBe(299_250);
    const ex = computeDealTotals(deal({ tax_exempt: true }));
    expect(ex.tax_estimate_cents).toBe(0);
    expect(ex.cash_price_cents).toBe(4_375_000);
    expect(computeDealTotals(deal({ tax_rate_estimate: null })).tax_estimate_cents).toBe(0);
  });

  it('taxable never goes below zero and a deal with no sale has no front percent', () => {
    const t = computeDealTotals(deal({ lines: [], fi: [], deposits: [] }));
    expect(t.taxable_estimate_cents).toBe(0);
    expect(t.front_gross_pct).toBeNull();
    expect(t.front_gross_cents).toBe(-100_000); // over-allowance alone
  });

  it('a draft line previews from qty × price; received trades and suppressed deposits count', () => {
    const t = computeDealTotals(deal({
      lines: [{ line_type: 'UNIT', qty: 1, unit_price_cents: 1_299_900, cost_cents: 1_050_000, taxable: true }],
      trades: [{ status: 'RECEIVED', acv_cents: null, allowance_cents: 200_000, payoff_cents: 0 }],
      deposits: [{ status: 'SUPPRESSED', amount_cents: 50_000 }],
    }));
    expect(t.sale_price_cents).toBe(1_299_900);
    expect(t.over_allowance_cents).toBe(0); // no ACV yet
    expect(t.deposits_cents).toBe(50_000);
  });

  it('over-allowance is allowance above ACV, never negative', () => {
    expect(overAllowanceCents({ acv_cents: 800_000, allowance_cents: 900_000 })).toBe(100_000);
    expect(overAllowanceCents({ acv_cents: 900_000, allowance_cents: 800_000 })).toBe(0);
    expect(overAllowanceCents({ acv_cents: null, allowance_cents: 800_000 })).toBe(0);
  });

  it('the margin floor matches approve_deal: below the percent or below the minimum', () => {
    const s = { margin_floor_pct: 0.08, min_front_gross_cents: 0 };
    expect(belowMarginFloor({ front_gross_pct: 0.0615, front_gross_cents: 120_000 }, s)).toBe(true);
    expect(belowMarginFloor({ front_gross_pct: 0.1341, front_gross_cents: 570_000 }, s)).toBe(false);
    expect(belowMarginFloor({ front_gross_pct: 0.2, front_gross_cents: 40_000 }, { margin_floor_pct: 0.08, min_front_gross_cents: 50_000 })).toBe(true);
    expect(belowMarginFloor({ front_gross_pct: null, front_gross_cents: 0 }, s)).toBe(false);
  });
});

// ---------------------------------------------------------------- rentals
const T0 = Date.parse('2026-10-01T08:00:00Z');
const H = 3_600_000;
const D = 24 * H;

describe('rental charge (pm.rental_charge)', () => {
  it('SQL constants are the ones mirrored: 59-minute grace, 28-day months, 7-day weeks', () => {
    expect(sql1109).toMatch(/- 3540\) \/ 86400\.0/);
    expect(sql1109).toMatch(/v_m := v_days \/ 28; v_w := \(v_days % 28\) \/ 7; v_d := v_days % 7;/);
    expect(sql1109).toMatch(/v_dpart := least\(v_d \* d, wk\);/);
    expect(sql1109).toMatch(/v_rest {2}:= least\(v_w \* wk \+ v_dpart, mo\);/);
  });

  it('9 days is 1 week + 2 days', () => {
    const c = rentalCharge(10_000, 40_000, 120_000, T0, T0 + 9 * D);
    expect(c).toMatchObject({ days: 9, months: 0, weeks: 1, extra_days: 2, rental_cents: 60_000 });
    expect(chargeWords(c)).toBe('1 week + 2 days');
  });

  it('returns within 59 minutes are not another day; a second later is', () => {
    expect(rentalCharge(10_000, 40_000, 120_000, T0, T0 + 9 * D + 59 * 60_000).days).toBe(9);
    const late = rentalCharge(10_000, 40_000, 120_000, T0, T0 + 9 * D + 59 * 60_000 + 1_000);
    expect(late).toMatchObject({ days: 10, weeks: 1, extra_days: 3, rental_cents: 70_000 });
  });

  it('days cap at a week and weeks + days cap at a month', () => {
    expect(rentalCharge(10_000, 40_000, 120_000, T0, T0 + 6 * D).rental_cents).toBe(40_000);
    expect(rentalCharge(10_000, 40_000, 120_000, T0, T0 + 27 * D).rental_cents).toBe(120_000);
    const m = rentalCharge(10_000, 40_000, 120_000, T0, T0 + 29 * D);
    expect(m).toMatchObject({ months: 1, weeks: 0, extra_days: 1, rental_cents: 130_000 });
    expect(chargeWords(m)).toBe('1 month + 1 day');
  });

  it('missing rates derive: week = 7 × day, month = 4 × week, day from the month', () => {
    const dayOnly = rentalCharge(1_000, null, null, T0, T0 + 30 * D);
    expect(dayOnly).toMatchObject({ rate_week_cents: 7_000, rate_month_cents: 28_000, rental_cents: 30_000 });
    const monthOnly = rentalCharge(null, null, 10_000, T0, T0 + 3 * D);
    expect(monthOnly).toMatchObject({ rate_day_cents: 358, rate_week_cents: 2_500, rental_cents: 1_074 });
    expect(() => rentalCharge(0, 0, 0, T0, T0 + D)).toThrow(); // zero means no rate, as nullif(…, 0)
    expect(() => rentalCharge(null, null, null, T0, T0 + D)).toThrow();
  });

  it('a short rental is one day; a backwards range is nothing', () => {
    expect(rentalCharge(10_000, null, null, T0, T0 + H / 2)).toMatchObject({ days: 1, rental_cents: 10_000 });
    expect(rentalCharge(10_000, null, null, T0, T0)).toEqual({ days: 0, months: 0, weeks: 0, extra_days: 0, rental_cents: 0 });
    expect(rentalCharge(10_000, null, null, '2026-10-01T08:00:00Z', '2026-10-03T08:00:00Z').days).toBe(2);
  });

  it('the most specific active rate wins (unit, model, category, default), newest first', () => {
    const L = 'loc-1';
    const r = (id: string, over: Partial<RentalRateRow>): RentalRateRow => ({
      id, location_id: L, asset_id: null, model: null, category: null, label: null, day_cents: 1, week_cents: null, month_cents: null,
      damage_waiver_pct: null, is_active: true, created_at: '2026-01-01T00:00:00Z', ...over,
    });
    const unit = { id: 'u1', location_id: L, model: 'SVL75', category: 'TRACK_LOADER' };
    const rates = [
      r('default-old', {}),
      r('default-new', { created_at: '2026-06-01T00:00:00Z' }),
      r('category', { category: 'TRACK_LOADER' }),
      r('model', { model: 'svl75' }),
      r('unit', { asset_id: 'u1' }),
      r('other-unit', { asset_id: 'u2' }),
      r('inactive-unit', { asset_id: 'u1', is_active: false, created_at: '2026-09-01T00:00:00Z' }),
      r('other-company', { location_id: 'loc-2', asset_id: 'u1' }),
    ];
    expect(pickRentalRate(rates, unit)?.id).toBe('unit');
    expect(pickRentalRate(rates.filter((x) => x.id !== 'unit'), unit)?.id).toBe('model');
    expect(pickRentalRate(rates.filter((x) => !['unit', 'model'].includes(x.id)), unit)?.id).toBe('category');
    expect(pickRentalRate(rates.filter((x) => x.id.startsWith('default')), unit)?.id).toBe('default-new');
    expect(pickRentalRate([], unit)).toBeNull();
  });

  it('reads a tstzrange and computes utilization', () => {
    expect(parseRange('["2026-10-20 14:00:00+00","2026-10-22 14:00:00+00")')).toEqual({
      start: Date.parse('2026-10-20T14:00:00Z'), end: Date.parse('2026-10-22T14:00:00Z'),
    });
    expect(parseRange(null)).toBeNull();
    expect(parseRange('garbage')).toBeNull();
    expect(utilization(45, 90)).toBe(0.5);
    expect(utilization(10, 0)).toBeNull();
    expect(utilization(100, 90)).toBe(1);
  });
});

// ---------------------------------------------------------------- service split
describe('pay-type split (DEALER_RO_CLOSED)', () => {
  const line = (over: Partial<SplitLine>): SplitLine => ({ kind: 'LABOR', pay_type: 'CUSTOMER', status: 'APPROVED', amount_cents: 0, qty: 1, unit_cost_cents: null, flag_hours: null, ...over });
  const lines: SplitLine[] = [
    line({ kind: 'LABOR', amount_cents: 25_000, flag_hours: 2 }),
    line({ kind: 'PART', amount_cents: 14_800, qty: 2, unit_cost_cents: 4_500 }),
    line({ kind: 'FEE', amount_cents: 1_200 }),
    line({ kind: 'LABOR', pay_type: 'WARRANTY', amount_cents: 19_000, flag_hours: 2 }),
    line({ kind: 'PART', pay_type: 'WARRANTY', amount_cents: 6_000, qty: 1, unit_cost_cents: 3_500 }),
    line({ kind: 'SUBLET', pay_type: 'INTERNAL', amount_cents: 8_000, qty: 1, unit_cost_cents: 6_000 }),
    line({ kind: 'SERVICE', pay_type: 'POLICY', amount_cents: 5_000, flag_hours: 0.5 }),
    line({ kind: 'LABOR', amount_cents: 99_999, status: 'DECLINED', flag_hours: 9 }),
    line({ kind: 'PART', amount_cents: 7_777, status: 'PROPOSED' }),
  ];

  it('mirrors the SQL buckets: labor = LABOR + SERVICE, misc = everything else', () => {
    expect(sql1109).toMatch(/filter \(where l\.kind in \('LABOR','SERVICE'\)\)/);
    expect(sql1109).toMatch(/filter \(where l\.kind not in \('LABOR','SERVICE','PART','SUBLET'\)\)/);
  });

  it('splits approved lines only, by who pays', () => {
    const s = paySplit(lines);
    expect(s.CUSTOMER).toMatchObject({ labor_cents: 25_000, parts_cents: 14_800, misc_cents: 1_200, total_cents: 41_000, parts_cost_cents: 9_000, flag_hours: 2, line_count: 3 });
    expect(s.WARRANTY).toMatchObject({ labor_cents: 19_000, parts_cents: 6_000, total_cents: 25_000, parts_cost_cents: 3_500, flag_hours: 2, line_count: 2 });
    expect(s.INTERNAL).toMatchObject({ sublet_cents: 8_000, sublet_cost_cents: 6_000, total_cents: 8_000, line_count: 1 });
    expect(s.POLICY).toMatchObject({ labor_cents: 5_000, flag_hours: 0.5, line_count: 1 });
    expect(splitTotal(s)).toBe(79_000);
  });

  it('an empty repair order splits to zero everywhere', () => {
    const s = paySplit([]);
    expect(splitTotal(s)).toBe(0);
    expect(s.WARRANTY.line_count).toBe(0);
  });
});

// ---------------------------------------------------------------- parts
const part = (id: string, part_number: string, status: CounterPart['status'] = 'ACTIVE', manufacturer: string | null = 'JD'): CounterPart => ({ id, part_number, manufacturer, description: `Part ${part_number}`, status });

describe('supersession (pm.resolve_part) and the counter state', () => {
  it('walks old → new to the current number, and stops on a loop', () => {
    const byId = new Map([
      ['a', { id: 'a', superseded_by_part_id: 'b' }],
      ['b', { id: 'b', superseded_by_part_id: 'c' }],
      ['c', { id: 'c', superseded_by_part_id: null }],
      ['x', { id: 'x', superseded_by_part_id: 'y' }],
      ['y', { id: 'y', superseded_by_part_id: 'x' }],
    ]);
    expect(walkSupersession('a', byId)).toEqual({ resolvedId: 'c', chain: ['a', 'b', 'c'] });
    expect(walkSupersession('c', byId)).toEqual({ resolvedId: 'c', chain: ['c'] });
    expect(walkSupersession('x', byId)).toEqual({ resolvedId: 'y', chain: ['x', 'y'] });
  });

  it('empty, not found, found, obsolete', () => {
    expect(counterLookup('  ', [])).toEqual({ kind: 'empty' });
    expect(counterLookup('am999', [])).toMatchObject({ kind: 'not_found', keyed: 'AM999' });
    const am = part('p1', 'AM125172');
    expect(counterLookup('am125172', [{ requested: am, resolved: am, chain: ['AM125172'] }])).toMatchObject({ kind: 'found', part: am, message: null });
    const ob = part('p9', 'M80000', 'OBSOLETE');
    const o = counterLookup('M80000', [{ requested: ob, resolved: ob, chain: ['M80000'] }]);
    expect(o.kind).toBe('obsolete');
  });

  it('a superseded number sells the replacement, and says so with the chain', () => {
    const old = part('p1', 'AM101378', 'SUPERSEDED');
    const mid = part('p2', 'AM107423', 'SUPERSEDED');
    const cur = part('p3', 'AM125172');
    const m: CounterMatch = { requested: old, resolved: cur, chain: ['AM101378', 'AM107423', 'AM125172'] };
    const r = counterLookup('AM101378', [m]);
    expect(r.kind).toBe('superseded');
    if (r.kind !== 'superseded') return;
    expect(r.part.id).toBe('p3');
    expect(r.message).toBe('AM101378 is replaced by AM125172 (through AM107423). The ticket sells AM125172.');
    const one = counterLookup('AM107423', [{ requested: mid, resolved: cur, chain: ['AM107423', 'AM125172'] }]);
    expect(one.kind === 'superseded' && one.message).toBe('AM107423 is replaced by AM125172. The ticket sells AM125172.');
  });

  it('the same number from two manufacturers asks which line', () => {
    const a = part('p1', '5101', 'ACTIVE', 'Stihl');
    const b = part('p2', '5101', 'ACTIVE', 'Husqvarna');
    const r = counterLookup('5101', [{ requested: a, resolved: a, chain: ['5101'] }, { requested: b, resolved: b, chain: ['5101'] }]);
    expect(r.kind).toBe('choose');
    if (r.kind === 'choose') expect(r.options.map((x) => x.manufacturer)).toEqual(['Stihl', 'Husqvarna']);
    // two old numbers that resolve to the same current part are one answer
    const cur = part('p3', '5102');
    expect(counterLookup('5101', [{ requested: a, resolved: cur, chain: ['5101', '5102'] }, { requested: b, resolved: cur, chain: ['5101', '5102'] }]).kind).toBe('superseded');
  });

  it('reads quantity and part number from the keyed entry', () => {
    expect(parseCounterEntry('3*am125172')).toEqual({ qty: 3, pn: 'AM125172' });
    expect(parseCounterEntry('2 x M806418')).toEqual({ qty: 2, pn: 'M806418' });
    expect(parseCounterEntry('1.5×TY26433')).toEqual({ qty: 1.5, pn: 'TY26433' });
    expect(parseCounterEntry('AM125172')).toEqual({ qty: 1, pn: 'AM125172' });
    expect(parseCounterEntry('0*AM125172')).toBeNull();
    expect(parseCounterEntry('   ')).toBeNull();
  });

  it('fills what is on the shelf and special-orders the rest', () => {
    expect(fillPlan(5, 3, false)).toEqual({ filled: 3, short: 2 });
    expect(fillPlan(2, 3, false)).toEqual({ filled: 2, short: 0 });
    expect(fillPlan(5, -1, false)).toEqual({ filled: 0, short: 5 });
    expect(fillPlan(5, 0, true)).toEqual({ filled: 5, short: 0 });
  });

  it('ticket totals: sold lines only, cores untaxed, tax on taxable lines', () => {
    const t = ticketTotals([
      { qty_filled: 2, unit_price_cents: 1_899, core_charge_cents: 0, taxable: true, unit_cost_cents: 1_100 },
      { qty_filled: 1, unit_price_cents: 14_500, core_charge_cents: 2_500, taxable: true, unit_cost_cents: 9_000 },
      { qty_filled: 0, unit_price_cents: 99_999, core_charge_cents: 0, taxable: true, unit_cost_cents: 1 },
    ], 0.07, false);
    expect(t).toEqual({ parts_cents: 18_298, core_charges_cents: 2_500, cost_cents: 11_200, taxable_estimate_cents: 18_298, tax_estimate_cents: 1_281, total_estimate_cents: 22_079 });
    expect(ticketTotals([{ qty_filled: 1, unit_price_cents: 1_000, core_charge_cents: 0, taxable: true, unit_cost_cents: null }], 0.07, true).tax_estimate_cents).toBe(0);
  });
});

// ---------------------------------------------------------------- units
describe('unit aging', () => {
  it('buckets match v_dealer_unit_inventory', () => {
    expect(agingBucket(null)).toBeNull();
    expect(agingBucket(90)).toBe('0-90');
    expect(agingBucket(91)).toBe('91-180');
    expect(agingBucket(180)).toBe('91-180');
    expect(agingBucket(181)).toBe('181-365');
    expect(agingBucket(366)).toBe('365+');
  });
  it('aged means in stock (IN_STOCK, PDI, DEMO, ON_HOLD) over 180 days, as the KPI counts', () => {
    expect(isAged({ unit_status: 'IN_STOCK', days_in_stock: 181 })).toBe(true);
    expect(isAged({ unit_status: 'DEMO', days_in_stock: 400 })).toBe(true);
    expect(isAged({ unit_status: 'IN_STOCK', days_in_stock: 180 })).toBe(false);
    expect(isAged({ unit_status: 'SOLD', days_in_stock: 400 })).toBe(false);
    expect(isAged({ unit_status: 'RENTAL', days_in_stock: 400 })).toBe(false);
    expect(sql1109).toMatch(/unit_status in \('IN_STOCK','PDI','DEMO','ON_HOLD'\)/);
  });
});
