import { describe, expect, it } from 'vitest';
import { is832, parse832, parseMillSheet, parsePriceFile } from './price-file';
import { buildFlooringPlan } from './setup';

// A minimal FCB2B-style 832: ISA (106 chars to the segment terminator), LIN / PID / CTP per item.
const isa = 'ISA*00*          *00*          *ZZ*MILLCO         *ZZ*DEALER         *261020*1200*U*00401*000000001*0*P*>~';
const EDI = [isa, 'GS*SC*MILLCO*DEALER*20261020*1200*1*X*004010', 'ST*832*0001', 'BCT*PC*2026-Q4', 'DTM*007*20261101',
  'LIN**SK*CPT-100*VN*SAXONY', 'PID*F*73***Saxony Plush', 'PID*F*74***Driftwood', 'CTP**NET*18.50**SY', 'CTP**MSR*32.00**SY',
  'LIN**SK*LVP-200', 'PID*F*73***Harbor Oak', 'CTP**DIS*2.79**SF',
  'LIN**SK*NO-PRICE', 'PID*F*73***Missing',
  'CTT*3', 'SE*14*0001', 'GE*1*1', 'IEA*1*000000001'].join('~');

describe('vendor price files (FLR-14)', () => {
  it('recognises an 832 and reads items, costs, retail, units and the effective date', () => {
    expect(isa.indexOf('~')).toBe(105);
    expect(is832(EDI)).toBe(true);
    const r = parse832(EDI);
    expect(r.source).toBe('FCB2B_832');
    expect(r.effectiveOn).toBe('2026-11-01');
    expect(r.lines).toEqual([
      { sku: 'CPT-100', style: 'Saxony Plush', color: 'Driftwood', uom: 'SY', cost_cents: 1850, retail_cents: 3200 },
      { sku: 'LVP-200', style: 'Harbor Oak', color: null, uom: 'SF', cost_cents: 279, retail_cents: null },
    ]);
    expect(r.issues).toEqual([expect.objectContaining({ message: expect.stringMatching(/NO-PRICE/) })]);
  });

  it('reads a mill price sheet with an effective date column, skipping rows without a price', () => {
    const csv = 'Style #,Style Name,Color,Unit,Dealer Cost,MSRP,Effective Date\nA1,Plush,Gray,YD,19.25,35,2026-11-01\nA2,Berber,,SF,,,\n';
    expect(is832(csv)).toBe(false);
    const r = parsePriceFile(csv);
    expect(r.source).toBe('MILL_SHEET');
    expect(r.effectiveOn).toBe('2026-11-01');
    expect(r.lines).toEqual([{ sku: 'A1', style: 'Plush', color: 'Gray', uom: 'SY', cost_cents: 1925, retail_cents: 3500 }]);
    expect(r.issues).toHaveLength(1);
    expect(parseMillSheet('nothing,here\n1,2').issues[0]!.message).toMatch(/SKU/);
  });
});

describe('flooring setup (FLR-01)', () => {
  it('normalises answers and only adds a counter-sales account for cash and carry', () => {
    const p = buildFlooringPlan({ mix: ['RETAIL_INSTALLED', 'RETAIL_INSTALLED'], installerPay: 'HOURLY', depositPct: 1.5, taxStates: ['ia', 'Nebraska', 'ne'], replacing: 'RFMS', measureFeeCents: 7500.4 });
    expect(p.settings.business_mix).toEqual(['RETAIL_INSTALLED']);
    expect(p.settings.default_deposit_pct).toBe(1);
    expect(p.settings.tax_states).toEqual(['IA', 'NE']);
    expect(p.settings.measure_fee_cents).toBe(7500);
    expect(p.cost_codes.find((c) => c.code === 'FL-200')!.cost_type).toBe('LABOR');
    expect(p.books_accounts.counter_sales).toBeUndefined();
    const cc = buildFlooringPlan({ mix: ['CASH_AND_CARRY'], installerPay: 'PIECE_RATE', depositPct: 0.5, taxStates: [], replacing: null, measureFeeCents: 0 });
    expect(cc.books_accounts.counter_sales).toBeDefined();
    expect(cc.cost_codes.find((c) => c.code === 'FL-200')!.cost_type).toBe('SUBCONTRACTOR');
    expect(cc.labor_rates.every((r) => Number.isInteger(r.sell_cents) && r.pay_cents < r.sell_cents)).toBe(true);
  });
});
