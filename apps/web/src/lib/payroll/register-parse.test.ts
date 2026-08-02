/**
 * Unit tests for the payroll-register drop-and-parse normalization + balance check.
 *
 * Pure, DB-free, gateway-free: we exercise `parseAmountToCents`,
 * `normalizeRegisterExtraction`, the role classifiers, and `buildProposedPayrollJE`
 * — asserting a well-formed register produces a BALANCED proposed payroll JE and a
 * register that does not foot is FLAGGED (never silently forced to balance).
 */

import { describe, it, expect } from 'vitest';
import {
  parseAmountToCents,
  toIsoDate,
  classifyEmployerTaxRole,
  classifyDeductionRole,
  normalizeRegisterExtraction,
  buildProposedPayrollJE,
  type NormalizedRegister,
} from './register-parse';

describe('parseAmountToCents', () => {
  it('parses numbers as dollars', () => {
    expect(parseAmountToCents(52350)).toBe(5235000);
    expect(parseAmountToCents(12.34)).toBe(1234);
  });
  it('parses currency strings with $ and commas', () => {
    expect(parseAmountToCents('$52,350.00')).toBe(5235000);
    expect(parseAmountToCents('1,234.56')).toBe(123456);
  });
  it('handles parenthesized and signed negatives', () => {
    expect(parseAmountToCents('(1,234.56)')).toBe(-123456);
    expect(parseAmountToCents('-42.00')).toBe(-4200);
  });
  it('returns 0 for blank/garbage rather than NaN', () => {
    expect(parseAmountToCents('')).toBe(0);
    expect(parseAmountToCents('abc')).toBe(0);
    expect(parseAmountToCents(null)).toBe(0);
    expect(parseAmountToCents(undefined)).toBe(0);
    expect(parseAmountToCents(Number.NaN)).toBe(0);
  });
  it('rounds to the nearest cent (no float drift)', () => {
    expect(parseAmountToCents(0.1 + 0.2)).toBe(30); // 0.30000000000000004 -> 30
  });
});

describe('toIsoDate', () => {
  it('accepts a valid ISO date', () => {
    expect(toIsoDate('2026-07-31')).toBe('2026-07-31');
  });
  it('rejects impossible and malformed dates', () => {
    expect(toIsoDate('2026-02-30')).toBeNull();
    expect(toIsoDate('07/31/2026')).toBeNull();
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate(42)).toBeNull();
  });
});

describe('role classifiers', () => {
  it('maps employer taxes to the right payable', () => {
    expect(classifyEmployerTaxRole('Employer FICA')).toBe('FICA_PAYABLE');
    expect(classifyEmployerTaxRole('Employer Medicare')).toBe('FICA_PAYABLE');
    expect(classifyEmployerTaxRole('FUTA')).toBe('FEDERAL_TAX_PAYABLE');
    expect(classifyEmployerTaxRole('SUTA')).toBe('STATE_TAX_PAYABLE');
    expect(classifyEmployerTaxRole('State UI')).toBe('STATE_TAX_PAYABLE');
  });
  it('maps deductions to their liability, degrading unknowns to accrued', () => {
    expect(classifyDeductionRole('Child Support')).toEqual({ role: 'GARNISHMENT_PAYABLE', degraded: false });
    expect(classifyDeductionRole('Health Insurance')).toEqual({ role: 'HEALTH_INSURANCE_PAYABLE', degraded: false });
    expect(classifyDeductionRole('401(k)')).toEqual({ role: 'RETIREMENT_PAYABLE', degraded: false });
    expect(classifyDeductionRole('United Way Charity')).toEqual({ role: 'ACCRUED_EXPENSES', degraded: true });
  });
});

/**
 * A clean, footing register:
 *   Gross 52,350.00
 *   Employee: Fed 6,282, State 2,094, FICA 4,004.78 (SS 3,245.70 + Medicare 759.08)
 *   Deductions: 401(k) 2,617.50, Health 1,200.00
 *   Net = 52,350 - (6,282 + 2,094 + 4,004.78) - (2,617.50 + 1,200) = 36,151.72
 *   Employer: FICA 4,004.78, FUTA 42.00, SUTA 210.00
 */
const CLEAN_REGISTER = {
  pay_date: '2026-07-31',
  period_start: '2026-07-16',
  period_end: '2026-07-31',
  employee_count: 12,
  gross_wages: 52350.0,
  employee_taxes: {
    federal: 6282.0,
    state: 2094.0,
    local: 0,
    fica_social_security: 3245.7,
    fica_medicare: 759.08,
  },
  employer_taxes: [
    { label: 'Employer FICA', amount: 4004.78 },
    { label: 'FUTA', amount: 42.0 },
    { label: 'SUTA', amount: 210.0 },
  ],
  deductions: [
    { label: '401(k)', amount: 2617.5 },
    { label: 'Health Insurance', amount: 1200.0 },
  ],
  net_pay: 36151.72,
  confidence: {
    pay_date: 0.99,
    gross_wages: 0.98,
    net_pay: 0.98,
    employee_taxes: 0.95,
    employer_taxes: 0.9,
    deductions: 0.92,
  },
};

describe('normalizeRegisterExtraction', () => {
  it('normalizes amounts to cents and keeps employee/employer taxes separate', () => {
    const reg = normalizeRegisterExtraction(CLEAN_REGISTER);
    expect(reg.payDate).toBe('2026-07-31');
    expect(reg.grossCents).toBe(5235000);
    expect(reg.netCents).toBe(3615172);
    expect(reg.federalWithholdingCents).toBe(628200);
    expect(reg.ficaEmployeeCents).toBe(400478); // SS + Medicare combined
    expect(reg.employerTaxes).toHaveLength(3);
    expect(reg.deductions).toHaveLength(2);
    expect(reg.lowConfidenceFields).toHaveLength(0);
  });

  it('never throws on a malformed shape; flags the blanks', () => {
    const reg = normalizeRegisterExtraction({ garbage: true });
    expect(reg.grossCents).toBe(0);
    expect(reg.netCents).toBe(0);
    expect(reg.lowConfidenceFields).toEqual(expect.arrayContaining(['pay_date', 'gross_wages', 'net_pay']));
  });

  it('falls back to a combined fica field when the split is absent', () => {
    const reg = normalizeRegisterExtraction({
      ...CLEAN_REGISTER,
      employee_taxes: { federal: 6282, state: 2094, local: 0, fica: 4004.78 },
    });
    expect(reg.ficaEmployeeCents).toBe(400478);
  });
});

describe('buildProposedPayrollJE — the balance check', () => {
  it('builds a BALANCED entry from a footing register', () => {
    const reg = normalizeRegisterExtraction(CLEAN_REGISTER);
    const je = buildProposedPayrollJE(reg);

    expect(je.balanced).toBe(true);
    expect(je.imbalanceCents).toBe(0);
    expect(je.registerFoots).toBe(true);
    expect(je.footingDeltaCents).toBe(0);
    expect(je.totalDebitCents).toBe(je.totalCreditCents);

    // Debits = gross + employer taxes.
    const employerTaxTotal = 400478 + 4200 + 21000;
    expect(je.totalDebitCents).toBe(5235000 + employerTaxTotal);

    // Wages debit present at gross.
    const wages = je.lines.find((l) => l.roleKey === 'WAGES_EXPENSE');
    expect(wages).toMatchObject({ side: 'DR', cents: 5235000 });

    // Employer tax expense debit is the summed employer taxes.
    const empTaxExp = je.lines.find((l) => l.roleKey === 'PAYROLL_TAX_EXPENSE');
    expect(empTaxExp).toMatchObject({ side: 'DR', cents: employerTaxTotal });

    // Net pay credit through Payments in Transit.
    const net = je.lines.find((l) => l.roleKey === 'PAYMENTS_IN_TRANSIT');
    expect(net).toMatchObject({ side: 'CR', cents: 3615172 });

    // FICA payable = employee FICA + employer FICA (merged onto one payable).
    const fica = je.lines.find((l) => l.roleKey === 'FICA_PAYABLE');
    expect(fica).toMatchObject({ side: 'CR', cents: 400478 + 400478 });

    // FUTA merged into federal payable; SUTA into state payable.
    const fed = je.lines.find((l) => l.roleKey === 'FEDERAL_TAX_PAYABLE');
    expect(fed?.cents).toBe(628200 + 4200);
    const state = je.lines.find((l) => l.roleKey === 'STATE_TAX_PAYABLE');
    expect(state?.cents).toBe(209400 + 21000);
  });

  it('FLAGS a register that does not foot (does not force a balance)', () => {
    // Net pay overstated by $100 -> the register no longer foots.
    const reg = normalizeRegisterExtraction({ ...CLEAN_REGISTER, net_pay: 36251.72 });
    const je = buildProposedPayrollJE(reg);

    expect(je.registerFoots).toBe(false);
    expect(je.footingDeltaCents).toBe(-10000); // gross - WH - deductions - net = -100.00
    expect(je.balanced).toBe(false);
    expect(je.imbalanceCents).toBe(-10000); // credits exceed debits by $100
  });

  it('flags a degraded deduction line for human remapping', () => {
    const reg = normalizeRegisterExtraction({
      ...CLEAN_REGISTER,
      deductions: [{ label: 'United Way Charity', amount: 2617.5 }, { label: 'Health Insurance', amount: 1200.0 }],
    });
    const je = buildProposedPayrollJE(reg);
    const accrued = je.lines.find((l) => l.roleKey === 'ACCRUED_EXPENSES');
    expect(accrued?.degraded).toBe(true);
    // Still foots (same totals; only the account mapping changed).
    expect(je.balanced).toBe(true);
  });

  it('an all-zero register is not marked balanced', () => {
    const je = buildProposedPayrollJE({
      payDate: null, periodStart: null, periodEnd: null, employeeCount: null,
      grossCents: 0, netCents: 0, federalWithholdingCents: 0, stateWithholdingCents: 0,
      localWithholdingCents: 0, ficaEmployeeCents: 0, employerTaxes: [], deductions: [],
      confidence: {}, lowConfidenceFields: [],
    } satisfies NormalizedRegister);
    expect(je.balanced).toBe(false);
    expect(je.totalDebitCents).toBe(0);
  });
});
