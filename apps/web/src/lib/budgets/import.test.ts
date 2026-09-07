import { describe, it, expect } from 'vitest';
import { parseCsv } from '@/lib/import/csv';
import {
  parseAmountCents,
  mapBudgetColumns,
  parseBudgetGrid,
  foldToPeriods,
  spreadAnnualCents,
  gridToParsedCsv,
} from './import';

describe('parseAmountCents', () => {
  it('parses plain, currency, and comma amounts to cents', () => {
    expect(parseAmountCents('1200').cents).toBe(120000);
    expect(parseAmountCents('$1,200.50').cents).toBe(120050);
    expect(parseAmountCents(' 12.34 ').cents).toBe(1234);
  });
  it('treats blank / dash as zero', () => {
    expect(parseAmountCents('')).toEqual({ cents: 0, ok: true });
    expect(parseAmountCents('-')).toEqual({ cents: 0, ok: true });
    expect(parseAmountCents('—')).toEqual({ cents: 0, ok: true });
  });
  it('reads accounting parentheses as negative', () => {
    expect(parseAmountCents('(500)').cents).toBe(-50000);
    expect(parseAmountCents('($1,000.00)').cents).toBe(-100000);
  });
  it('flags non-numeric cells', () => {
    expect(parseAmountCents('abc').ok).toBe(false);
    expect(parseAmountCents('12x').ok).toBe(false);
  });
});

describe('mapBudgetColumns / layout detection', () => {
  it('detects a monthly layout from month headers', () => {
    const { layout, mapping } = mapBudgetColumns(['Account', 'Jan', 'Feb', 'Mar']);
    expect(layout).toBe('monthly');
    expect(mapping.account).toBe('Account');
    expect(mapping.months[0]).toBe('Jan');
    expect(mapping.months[2]).toBe('Mar');
  });
  it('detects an annual layout from a total column', () => {
    const { layout, mapping } = mapBudgetColumns(['Account Number', 'Annual Budget']);
    expect(layout).toBe('annual');
    expect(mapping.account).toBe('Account Number');
    expect(mapping.annual).toBe('Annual Budget');
  });
});

describe('parseBudgetGrid — monthly', () => {
  const csv = [
    'Account,Jan,Feb,Mar',
    '4000,1000,1000,1000',
    '6000,"$2,000.00",,500',
    ',,,', // blank spacer row — skipped
  ].join('\n');

  it('extracts month cells, skips blanks, and foots', () => {
    const parsed = parseCsv(csv);
    const r = parseBudgetGrid(parsed);
    expect(r.layout).toBe('monthly');
    expect(r.errors).toEqual([]);
    expect(r.accountRefs).toEqual(['4000', '6000']);
    // 3 cells for 4000 + 2 cells for 6000 (Feb blank skipped)
    expect(r.rows.length).toBe(5);
    expect(r.totalCents).toBe(300000 + 200000 + 50000);
    expect(r.rowCount).toBe(2);
  });
});

describe('parseBudgetGrid — annual + fold', () => {
  it('spreads an annual amount across 12 months to the cent', () => {
    const csv = 'Account,Annual\n4000,1200.05\n';
    const r = parseBudgetGrid(parseCsv(csv));
    expect(r.layout).toBe('annual');
    expect(r.rows).toEqual([{ rowNum: 2, accountRef: '4000', period: 'annual', amountCents: 120005 }]);

    const folded = foldToPeriods(r.rows).get('4000')!;
    const total = Object.values(folded).reduce((s, c) => s + c, 0);
    expect(total).toBe(120005); // foots exactly
    // remainder lands in January (period 1)
    expect(folded[1]).toBeGreaterThan(folded[2]);
  });
});

describe('spreadAnnualCents', () => {
  it('is even with the remainder in January', () => {
    const s = spreadAnnualCents(100);
    // base = trunc(100/12) = 8; remainder = 100 - 96 = 4; Jan = base + remainder = 12
    expect(s[1]).toBe(12);
    expect(s[2]).toBe(8);
    expect(Object.values(s).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('foldToPeriods — monthly sum + omit zeros', () => {
  it('sums repeated periods and omits zero cells', () => {
    const folded = foldToPeriods([
      { rowNum: 2, accountRef: '4000', period: 1, amountCents: 100 },
      { rowNum: 3, accountRef: '4000', period: 1, amountCents: 50 },
      { rowNum: 4, accountRef: '4000', period: 2, amountCents: 200 },
    ]).get('4000')!;
    expect(folded[1]).toBe(150);
    expect(folded[2]).toBe(200);
    expect(folded[3]).toBeUndefined();
  });
});

describe('gridToParsedCsv', () => {
  it('keys xlsx string rows by header and disambiguates duplicates', () => {
    const p = gridToParsedCsv({ headers: ['Account', 'Jan', 'Jan'], rows: [['4000', '10', '20']] });
    expect(p.headers).toEqual(['Account', 'Jan', 'Jan']);
    expect(p.rows[0]['Account']).toBe('4000');
    expect(p.rows[0]['Jan']).toBe('10');
    expect(p.rows[0]['Jan (3)']).toBe('20');
  });
});
