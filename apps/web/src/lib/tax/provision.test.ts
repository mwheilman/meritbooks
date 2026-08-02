import { describe, it, expect } from 'vitest';
import {
  computeProvision,
  buildProvisionJournalLines,
  effectiveRateReconciliation,
  type ProvisionInput,
  type ProvisionResult,
} from './provision';

// A canonical scenario, hand-computed at a 21% federal rate:
//   pretax book income        = $1,000,000            = 100_000_000 cents
//   permanent additions       = $50,000 (meals/fines) =   5_000_000
//   permanent subtractions    = $0
//   temporary additions       = $30,000 (accrued)     =   3_000_000  → deductible → DTA
//   temporary subtractions    = $80,000 (tax depr.)   =   8_000_000  → taxable    → DTL
//
//   permanent net   =  5,000,000
//   temporary net   =  3,000,000 − 8,000,000 = −5,000,000
//   taxable income  = 100,000,000 + 5,000,000 − 5,000,000 = 100,000,000
//   current tax     = 21% × 100,000,000 = 21,000,000
//   Δ DTA           = 21% ×   3,000,000 =    630,000
//   Δ DTL           = 21% ×   8,000,000 =  1,680,000
//   deferred tax    = ΔDTL − ΔDTA = 1,680,000 − 630,000 = 1,050,000  (net expense)
//   total provision = 21,000,000 + 1,050,000 = 22,050,000
//   check identity  = (pretax + perm net) × 21% = 105,000,000 × 21% = 22,050,000 ✓
//   statutory tax   = 21% × 100,000,000 = 21,000,000
//   perm tax effect = 22,050,000 − 21,000,000 = 1,050,000  (= 5,000,000 × 21%)
//   effective rate  = 22,050,000 / 100,000,000 = 22.05%
const BASE: ProvisionInput = {
  pretaxBookIncomeCents: 100_000_000,
  statutoryRatePct: 21,
  permanentAdditionsCents: 5_000_000,
  permanentSubtractionsCents: 0,
  temporaryAdditionsCents: 3_000_000,
  temporarySubtractionsCents: 8_000_000,
};

describe('computeProvision — current, deferred, effective rate (hand-computed)', () => {
  const r = computeProvision(BASE);

  it('computes taxable income from the M-1 permanent/temporary split', () => {
    expect(r.permanentNetCents).toBe(5_000_000);
    expect(r.temporaryNetCents).toBe(-5_000_000);
    expect(r.taxableIncomeCents).toBe(100_000_000);
  });

  it('computes current tax = taxable income × rate', () => {
    expect(r.currentTaxCents).toBe(21_000_000);
  });

  it('computes deferred tax from temporary differences → DTA / DTL', () => {
    expect(r.dtaChangeCents).toBe(630_000);
    expect(r.dtlChangeCents).toBe(1_680_000);
    expect(r.deferredTaxCents).toBe(1_050_000);
    expect(r.netDeferredTaxAssetCents).toBe(630_000 - 1_680_000);
  });

  it('computes total provision = current + deferred = (pretax + perm net) × rate', () => {
    expect(r.totalProvisionCents).toBe(22_050_000);
    expect(r.totalProvisionCents).toBe(
      Math.round(((r.pretaxBookIncomeCents + r.permanentNetCents) * 21) / 100),
    );
  });

  it('reconciles the effective rate: statutory + permanent effect = total', () => {
    expect(r.statutoryTaxCents).toBe(21_000_000);
    expect(r.permanentTaxEffectCents).toBe(1_050_000);
    expect(r.statutoryTaxCents + r.permanentTaxEffectCents).toBe(r.totalProvisionCents);
    expect(r.effectiveRatePct).toBe(22.05);
  });
});

describe('computeProvision — degrade-safe & edge cases', () => {
  it('with no differences, taxable = book and effective = statutory', () => {
    const r = computeProvision({
      pretaxBookIncomeCents: 4_000_000,
      statutoryRatePct: 21,
      permanentAdditionsCents: 0,
      permanentSubtractionsCents: 0,
      temporaryAdditionsCents: 0,
      temporarySubtractionsCents: 0,
    });
    expect(r.taxableIncomeCents).toBe(4_000_000);
    expect(r.currentTaxCents).toBe(840_000);
    expect(r.deferredTaxCents).toBe(0);
    expect(r.totalProvisionCents).toBe(840_000);
    expect(r.effectiveRatePct).toBe(21);
  });

  it('a book loss produces a benefit (negative provision) and 0 effective rate at pretax 0', () => {
    const loss = computeProvision({
      pretaxBookIncomeCents: -2_000_000,
      statutoryRatePct: 21,
      permanentAdditionsCents: 0,
      permanentSubtractionsCents: 0,
      temporaryAdditionsCents: 0,
      temporarySubtractionsCents: 0,
    });
    expect(loss.currentTaxCents).toBe(-420_000);
    expect(loss.totalProvisionCents).toBe(-420_000);

    const zero = computeProvision({ ...BASE, pretaxBookIncomeCents: 0 });
    expect(zero.effectiveRatePct).toBe(0);
  });

  it('rejects an invalid rate', () => {
    expect(() => computeProvision({ ...BASE, statutoryRatePct: -1 })).toThrow();
  });
});

describe('buildProvisionJournalLines — the provision JE is balanced', () => {
  const r = computeProvision(BASE);
  const accounts = {
    incomeTaxExpenseAccountId: 'exp',
    incomeTaxesPayableAccountId: 'pay',
    deferredTaxAssetAccountId: 'dta',
    deferredTaxLiabilityAccountId: 'dtl',
  };

  it('emits one line per non-zero component, on the correct side', () => {
    const lines = buildProvisionJournalLines(r, accounts, 'loc-1', 'FY2026 provision');
    const by = (id: string) => lines.find((l) => l.account_id === id)!;
    expect(by('exp').debit_cents).toBe(22_050_000); // expense debit = total provision
    expect(by('pay').credit_cents).toBe(21_000_000); // payable credit = current tax
    expect(by('dta').debit_cents).toBe(630_000); // DTA debit = Δ DTA
    expect(by('dtl').credit_cents).toBe(1_680_000); // DTL credit = Δ DTL
    for (const l of lines) expect(l.location_id).toBe('loc-1');
  });

  it('debits equal credits (double-entry holds)', () => {
    const lines = buildProvisionJournalLines(r, accounts, 'loc-1');
    const debits = lines.reduce((s, l) => s + l.debit_cents, 0);
    const credits = lines.reduce((s, l) => s + l.credit_cents, 0);
    expect(debits).toBe(credits);
    expect(debits).toBe(22_050_000 + 630_000);
  });

  it('flips sides for a net benefit and still balances', () => {
    const benefit: ProvisionResult = computeProvision({
      pretaxBookIncomeCents: -5_000_000,
      statutoryRatePct: 21,
      permanentAdditionsCents: 0,
      permanentSubtractionsCents: 0,
      temporaryAdditionsCents: 0,
      temporarySubtractionsCents: 0,
    });
    const lines = buildProvisionJournalLines(benefit, accounts, 'loc-1');
    const exp = lines.find((l) => l.account_id === 'exp')!;
    const pay = lines.find((l) => l.account_id === 'pay')!;
    // Benefit: expense is credited, receivable/payable is debited.
    expect(exp.credit_cents).toBe(1_050_000);
    expect(pay.debit_cents).toBe(1_050_000);
    const debits = lines.reduce((s, l) => s + l.debit_cents, 0);
    const credits = lines.reduce((s, l) => s + l.credit_cents, 0);
    expect(debits).toBe(credits);
  });

  it('throws if a needed deferred account is missing', () => {
    expect(() =>
      buildProvisionJournalLines(r, { incomeTaxExpenseAccountId: 'exp', incomeTaxesPayableAccountId: 'pay' }, 'loc-1'),
    ).toThrow(/Deferred Tax Asset/);
  });
});

describe('effectiveRateReconciliation', () => {
  it('produces a ladder that ties to the total provision', () => {
    const r = computeProvision(BASE);
    const rows = effectiveRateReconciliation(r);
    expect(rows).toHaveLength(3);
    expect(rows[0].amountCents + rows[1].amountCents).toBe(rows[2].amountCents);
    expect(rows[2].ratePct).toBe(22.05);
  });
});
