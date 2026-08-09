import { describe, it, expect } from 'vitest';
import {
  parseDelimited,
  guessMapping,
  aggregateRows,
  aggregatedToNormalized,
  applySavedMapping,
  headerSignature,
  cellToCents,
  type ColumnMapping,
} from './register-csv';
import { buildProposedPayrollJE } from './register-parse';

describe('cellToCents', () => {
  it('parses currency strings, parens, and blanks', () => {
    expect(cellToCents('$1,234.56')).toBe(123456);
    expect(cellToCents('(50.00)')).toBe(-5000);
    expect(cellToCents('')).toBe(0);
    expect(cellToCents('abc')).toBe(0);
    expect(cellToCents(100)).toBe(10000);
  });
});

describe('parseDelimited', () => {
  it('parses a comma CSV with a header row', () => {
    const g = parseDelimited('Employee,Gross,Net\nAlice,1000.00,800.00\nBob,2000,1500');
    expect(g.headers).toEqual(['Employee', 'Gross', 'Net']);
    expect(g.rows).toHaveLength(2);
    expect(g.rows[0]).toEqual(['Alice', '1000.00', '800.00']);
  });

  it('handles quoted fields with embedded commas and skips blank lines', () => {
    const g = parseDelimited('Name,Amount\n"Smith, John","1,000.00"\n\n"Doe, Jane",2000');
    expect(g.rows).toHaveLength(2);
    expect(g.rows[0]).toEqual(['Smith, John', '1,000.00']);
  });

  it('auto-detects a tab delimiter', () => {
    const g = parseDelimited('Employee\tGross\tNet\nAlice\t1000\t800');
    expect(g.headers).toEqual(['Employee', 'Gross', 'Net']);
    expect(g.rows[0]).toEqual(['Alice', '1000', '800']);
  });
});

describe('guessMapping', () => {
  it('maps common payroll headers deterministically', () => {
    const headers = ['Employee', 'Gross Pay', 'Federal Income Tax', 'State Tax', 'Social Security', 'Medicare', 'Net Pay'];
    const map = guessMapping(headers);
    const t = (h: string) => map.find((m) => m.header === h)!.target;
    expect(t('Employee')).toBe('employee');
    expect(t('Gross Pay')).toBe('gross');
    expect(t('Federal Income Tax')).toBe('fed_wh');
    expect(t('State Tax')).toBe('state_wh');
    expect(t('Social Security')).toBe('fica_ss');
    expect(t('Medicare')).toBe('fica_medicare');
    expect(t('Net Pay')).toBe('net');
  });

  it('classifies employer taxes and deductions distinctly from employee withholdings', () => {
    const map = guessMapping(['Employer FICA', 'FUTA', 'SUTA', '401(k)', 'Health Insurance', 'Child Support']);
    const t = (h: string) => map.find((m) => m.header === h)!.target;
    expect(t('Employer FICA')).toBe('employer_tax');
    expect(t('FUTA')).toBe('employer_tax');
    expect(t('SUTA')).toBe('employer_tax');
    expect(t('401(k)')).toBe('deduction');
    expect(t('Health Insurance')).toBe('deduction');
    expect(t('Child Support')).toBe('deduction');
  });
});

describe('aggregateRows → buildProposedPayrollJE', () => {
  // A footing register: gross = net + employee WH + deductions.
  //   gross 3000 ; fed 300 ; state 100 ; SS 186 ; med 43.5 ; 401k 150 ; net 2220.5
  //   employer: employer FICA 229.5 ; FUTA 18
  const csv = [
    'Employee,Gross,Federal Tax,State Tax,Social Security,Medicare,401(k),Employer FICA,FUTA,Net Pay',
    'Alice,2000.00,200.00,60.00,124.00,29.00,100.00,153.00,12.00,1487.00',
    'Bob,1000.00,100.00,40.00,62.00,14.50,50.00,76.50,6.00,733.50',
  ].join('\n');

  it('sums columns and builds a balanced payroll JE', () => {
    const g = parseDelimited(csv);
    const mapping = guessMapping(g.headers);
    const agg = aggregateRows(g.rows, mapping);

    expect(agg.grossCents).toBe(300000);
    expect(agg.netCents).toBe(222050);
    expect(agg.federalWithholdingCents).toBe(30000);
    expect(agg.stateWithholdingCents).toBe(10000);
    expect(agg.ficaEmployeeCents).toBe(18600 + 4350);
    expect(agg.employerTaxes.reduce((s, t) => s + t.cents, 0)).toBe(22950 + 1800);
    expect(agg.deductions.reduce((s, d) => s + d.cents, 0)).toBe(15000);
    expect(agg.employeeCount).toBe(2);
    expect(agg.registerFoots).toBe(true);
    expect(agg.footingDeltaCents).toBe(0);

    const normalized = aggregatedToNormalized(agg, { payDate: '2026-01-31', periodStart: null, periodEnd: null });
    const je = buildProposedPayrollJE(normalized);
    expect(je.balanced).toBe(true);
    expect(je.imbalanceCents).toBe(0);
    expect(je.totalDebitCents).toBe(je.totalCreditCents);
    // Debits = gross + employer taxes.
    expect(je.totalDebitCents).toBe(300000 + 22950 + 1800);
  });

  it('flags a register that does not foot but still reports totals', () => {
    // Net overstated by 100.00 → does not foot.
    const bad = parseDelimited(csv.replace('1487.00', '1587.00'));
    const agg = aggregateRows(bad.rows, guessMapping(bad.headers));
    expect(agg.registerFoots).toBe(false);
    expect(agg.footingDeltaCents).toBe(-10000);
    const je = buildProposedPayrollJE(aggregatedToNormalized(agg, { payDate: null, periodStart: null, periodEnd: null }));
    // The built JE is intentionally NOT forced to balance when the register is off.
    expect(je.balanced).toBe(false);
  });
});

describe('saved mapping round-trip', () => {
  it('re-applies a saved mapping by header and falls back to guess for new columns', () => {
    const headers = ['Worker', 'Base Pay', 'New Bonus Col'];
    const saved = [
      { header: 'Worker', target: 'employee' as const },
      { header: 'Base Pay', target: 'gross' as const },
    ];
    const applied: ColumnMapping[] = applySavedMapping(headers, saved);
    expect(applied.find((m) => m.header === 'Worker')!.target).toBe('employee');
    expect(applied.find((m) => m.header === 'Base Pay')!.target).toBe('gross');
    // Unknown column falls back to the deterministic guess (ignore here).
    expect(applied.find((m) => m.header === 'New Bonus Col')!.target).toBe('ignore');
  });

  it('produces a stable, order-independent header signature', () => {
    expect(headerSignature(['A', 'B', 'C'])).toBe(headerSignature(['c', 'b', 'a']));
  });
});
