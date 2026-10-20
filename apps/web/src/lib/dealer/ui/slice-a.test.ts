import { describe, it, expect } from 'vitest';
import { agingRange, availableActions, daysInStock, shiftDays, unitFlags, actionNeedsApproval } from './unit-flags';
import { dealRecap, lienUnpaid, tradeNeedsApproval } from './deal-math';

const TODAY = '2026-10-20';

describe('unit-flags: dates + aging range', () => {
  it('shifts ISO dates without TZ drift', () => {
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(shiftDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('computes days in stock, never negative', () => {
    expect(daysInStock('2026-10-10', TODAY)).toBe(10);
    expect(daysInStock('2026-11-01', TODAY)).toBe(0);
    expect(daysInStock(null, TODAY)).toBeNull();
  });
  it('maps an age bucket to a received_date range that contains exactly that bucket', () => {
    const r = agingRange(TODAY, 91, 180);
    expect(r.to).toBe(shiftDays(TODAY, -91));
    expect(r.from).toBe(shiftDays(TODAY, -180));
    // a unit received exactly 91 days ago is in; 90 days ago is out
    expect(daysInStock(r.to!, TODAY)).toBe(91);
    expect(daysInStock(r.from!, TODAY)).toBe(180);
    expect(agingRange(TODAY, 0, null)).toEqual({});
    expect(agingRange(TODAY, 366)).toEqual({ to: shiftDays(TODAY, -366) });
  });
});

describe('unit-flags: flags', () => {
  const base = { status: 'IN_STOCK' as const, condition: 'NEW' as const, is_consignment: false, received_date: TODAY, warranty_registered_date: null };
  const policy = { aging_buckets: [90, 180, 270, 365], term_warning_days: 60 };

  it('no flags for a fresh owned unit', () => {
    expect(unitFlags(base, null, policy, TODAY)).toEqual([]);
  });
  it('aged flag names the last edge passed (DL-4)', () => {
    const f = unitFlags({ ...base, received_date: shiftDays(TODAY, -200) }, null, policy, TODAY);
    expect(f.map((x) => x.label)).toEqual(['Over 180 days']);
    const g = unitFlags({ ...base, received_date: shiftDays(TODAY, -400) }, null, policy, TODAY);
    expect(g[0].label).toBe('Over 365 days');
    // exactly on the edge is not past it
    expect(unitFlags({ ...base, received_date: shiftDays(TODAY, -90) }, null, policy, TODAY)).toEqual([]);
  });
  it('term window and past-term flags from the live note maturity', () => {
    const near = unitFlags(base, { status: 'OPEN', maturity_date: shiftDays(TODAY, 30) }, policy, TODAY);
    expect(near.map((x) => x.key)).toEqual(['term']);
    const past = unitFlags(base, { status: 'OPEN', maturity_date: shiftDays(TODAY, -3) }, policy, TODAY);
    expect(past.map((x) => x.key)).toEqual(['past_term']);
    expect(past[0].tone).toBe('danger');
    // a paid-off note is not live — no flag
    expect(unitFlags(base, { status: 'PAID_OFF', maturity_date: shiftDays(TODAY, -3) }, policy, TODAY)).toEqual([]);
  });
  it('demo on floor plan (DL-12) only when a live note exists', () => {
    expect(unitFlags({ ...base, condition: 'DEMO' }, null, policy, TODAY)).toEqual([]);
    const f = unitFlags({ ...base, condition: 'DEMO' }, { status: 'OPEN', maturity_date: null }, policy, TODAY);
    expect(f.map((x) => x.key)).toEqual(['demo_floored']);
  });
  it('warranty registration without a sale is an SOT signal; sold units are not flagged', () => {
    const f = unitFlags({ ...base, warranty_registered_date: '2026-10-01' }, null, policy, TODAY);
    expect(f[0]).toMatchObject({ key: 'registered_unsold', tone: 'danger' });
    expect(unitFlags({ ...base, status: 'SOLD', warranty_registered_date: '2026-10-01' }, null, policy, TODAY)).toEqual([]);
  });
  it('sold-unpaid note → payoff owed; consignment flagged', () => {
    const f = unitFlags({ ...base, status: 'SOLD', is_consignment: true }, { status: 'SOLD_UNPAID', maturity_date: null }, policy, TODAY);
    expect(f.map((x) => x.key)).toEqual(['payoff_owed', 'consignment']);
  });
});

describe('unit-flags: action availability mirrors the D1 service', () => {
  const u = { status: 'IN_STOCK' as const, condition: 'NEW' as const, is_consignment: false, cost_cents: 1_040_000 };
  it('in-stock floored new unit', () => {
    const a = availableActions(u, { hasLiveNote: true, hasSale: false });
    expect(a.MARK_DEMO).toBe(true);
    expect(a.UNMARK_DEMO).toBe(false);
    expect(a.WRITE_DOWN).toBe(true);
    expect(a.VOID).toBe(false); // has cost + live note
    expect(a.MARK_DELIVERED).toBe(false);
    expect(a.RECORD_SALE).toBe(true);
    expect(a.ADD_COST).toBe(true);
  });
  it('sold unit can only be delivered / registered', () => {
    const a = availableActions({ ...u, status: 'SOLD' }, { hasLiveNote: false, hasSale: true });
    expect(a.MARK_DELIVERED).toBe(true);
    expect(a.RECORD_SALE).toBe(false);
    expect(a.ADD_COST).toBe(false);
    expect(a.RETURN_TO_OEM).toBe(false);
    expect(a.RECORD_WARRANTY_REGISTRATION).toBe(true);
  });
  it('void only with no cost, note or sale', () => {
    expect(availableActions({ ...u, cost_cents: 0 }, { hasLiveNote: false, hasSale: false }).VOID).toBe(true);
    expect(availableActions({ ...u, cost_cents: 0 }, { hasLiveNote: false, hasSale: true }).VOID).toBe(false);
  });
  it('approval-gated actions', () => {
    expect(actionNeedsApproval('WRITE_DOWN')).toBe(true);
    expect(actionNeedsApproval('MARK_DEMO')).toBe(false);
  });
});

describe('deal-math (FPB §3.4 / §3.5)', () => {
  it('§3.4 sale with a deposit: customer owes price − deposit', () => {
    const r = dealRecap(
      { salePriceCents: 1_350_000, taxCents: 0, retailRebateCents: 0, depositAppliedCents: 100_000, unitCostCents: 1_040_000, trade: null },
      'LOWER_OF_ACV_AND_ALLOWANCE',
      2000,
    );
    expect(r.receivableCents).toBe(1_350_000);
    expect(r.dueAfterDepositCents).toBe(1_250_000);
    expect(r.estimatedGrossCents).toBe(310_000);
    expect(r.trade).toBeNull();
    expect(r.overAllowanceWarn).toBe(false);
  });
  it('§3.5 trade: AR 1,170,000, recorded 250,000, over-allowance 50,000', () => {
    const r = dealRecap(
      { salePriceCents: 1_350_000, taxCents: 0, retailRebateCents: 0, depositAppliedCents: 0, unitCostCents: 1_040_000, trade: { allowanceCents: 300_000, acvCents: 250_000, lienPayoffCents: 120_000 } },
      'LOWER_OF_ACV_AND_ALLOWANCE',
      2000,
    );
    expect(r.receivableCents).toBe(1_170_000);
    expect(r.trade).toEqual({ recordedValueCents: 250_000, overAllowanceCents: 50_000, underAllowanceCents: 0 });
    expect(r.overAllowanceBps).toBe(370);
    expect(r.overAllowanceWarn).toBe(false);
    expect(r.estimatedGrossCents).toBe(1_350_000 - 1_040_000 - 50_000);
    expect(r.lienPayoffCents).toBe(120_000);
  });
  it('ACV policy books an under-allowance, no over-allowance; DL-11 warns at the threshold', () => {
    const acv = dealRecap(
      { salePriceCents: 100_000, taxCents: 0, retailRebateCents: 0, depositAppliedCents: 0, unitCostCents: 50_000, trade: { allowanceCents: 20_000, acvCents: 30_000, lienPayoffCents: 0 } },
      'ACV',
      2000,
    );
    expect(acv.trade).toEqual({ recordedValueCents: 30_000, overAllowanceCents: 0, underAllowanceCents: 10_000 });
    const warn = dealRecap(
      { salePriceCents: 100_000, taxCents: 0, retailRebateCents: 0, depositAppliedCents: 0, unitCostCents: 50_000, trade: { allowanceCents: 40_000, acvCents: 20_000, lienPayoffCents: 0 } },
      'LOWER_OF_ACV_AND_ALLOWANCE',
      2000,
    );
    expect(warn.overAllowanceBps).toBe(2000);
    expect(warn.overAllowanceWarn).toBe(true);
  });
  it('tax and retail rebate flow into what the customer owes', () => {
    const r = dealRecap(
      { salePriceCents: 1_000_000, taxCents: 70_000, retailRebateCents: 50_000, depositAppliedCents: 0, unitCostCents: 0, trade: null },
      'LOWER_OF_ACV_AND_ALLOWANCE',
      2000,
    );
    expect(r.receivableCents).toBe(1_020_000);
  });
  it('trade approval threshold (0 = every trade) and lien clock', () => {
    expect(tradeNeedsApproval(0, 0)).toBe(true);
    expect(tradeNeedsApproval(99, 100)).toBe(false);
    expect(lienUnpaid('OWED', '2026-10-01', TODAY, 10)).toEqual({ days: 19, overdue: true });
    expect(lienUnpaid('PROPOSED', '2026-10-15', TODAY, 10)).toEqual({ days: 5, overdue: false });
    expect(lienUnpaid('PAID', '2026-10-01', TODAY, 10)).toBeNull();
    expect(lienUnpaid('NONE', '2026-10-01', TODAY, 10)).toBeNull();
  });
});
