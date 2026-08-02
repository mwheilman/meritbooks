import { describe, it, expect } from 'vitest';
import {
  translateEntityTB,
  resolveTranslationRates,
  rateForType,
  CTA_ACCOUNT_NUMBER,
  type FxRateRow,
} from './fx';
import { consolidate, type EntityAccountBalance } from './consolidate';

/**
 * Multi-currency translation correctness (GATE 11a). The current-rate method:
 * P&L at AVERAGE, ASSET/LIABILITY at CLOSING, EQUITY at HISTORICAL, with a CTA plug
 * so the translated balance sheet ties to the cent. Single-currency entities MUST
 * pass through byte-for-byte, so the consolidated output is unchanged pre-FX.
 * All money is bigint cents; rates are numeric multipliers.
 */

const bal = (
  entityId: string,
  accountNumber: string,
  accountType: EntityAccountBalance['accountType'],
  naturalBalanceCents: number,
): EntityAccountBalance => ({
  entityId,
  accountNumber,
  accountName: `${accountType} ${accountNumber}`,
  accountType,
  isEliminating: false,
  role: null,
  naturalBalanceCents,
});

// A balanced EUR trial balance: assets 1,000,000 = liab 400,000 + equity 500,000 + NI 100,000.
const eurTB = (entity = 'F'): EntityAccountBalance[] => [
  bal(entity, '1000', 'ASSET', 1_000_000),
  bal(entity, '2000', 'LIABILITY', 400_000),
  bal(entity, '3000', 'EQUITY', 500_000),
  bal(entity, '4000', 'REVENUE', 300_000),
  bal(entity, '6000', 'OPEX', 200_000),
];

describe('rateForType', () => {
  it('routes P&L→average, ASSET/LIABILITY→closing, EQUITY→historical', () => {
    const rates = { average: 1.05, closing: 1.1, historical: 1.2 };
    expect(rateForType('REVENUE', rates)).toBe(1.05);
    expect(rateForType('COGS', rates)).toBe(1.05);
    expect(rateForType('OPEX', rates)).toBe(1.05);
    expect(rateForType('OTHER', rates)).toBe(1.05);
    expect(rateForType('ASSET', rates)).toBe(1.1);
    expect(rateForType('LIABILITY', rates)).toBe(1.1);
    expect(rateForType('EQUITY', rates)).toBe(1.2);
  });
});

describe('translateEntityTB — current-rate method + CTA', () => {
  const rates = { average: 1.05, closing: 1.1, historical: 1.2 };
  const r = translateEntityTB(eurTB(), {
    functionalCurrency: 'EUR',
    reportingCurrency: 'USD',
    rates,
  });

  it('translates the balance sheet at the CLOSING rate', () => {
    const asset = r.translated.find((b) => b.accountNumber === '1000')!;
    const liab = r.translated.find((b) => b.accountNumber === '2000')!;
    expect(asset.naturalBalanceCents).toBe(1_100_000); // 1,000,000 × 1.10
    expect(liab.naturalBalanceCents).toBe(440_000); // 400,000 × 1.10
  });

  it('translates the P&L at the AVERAGE rate', () => {
    const rev = r.translated.find((b) => b.accountNumber === '4000')!;
    const opex = r.translated.find((b) => b.accountNumber === '6000')!;
    expect(rev.naturalBalanceCents).toBe(315_000); // 300,000 × 1.05
    expect(opex.naturalBalanceCents).toBe(210_000); // 200,000 × 1.05
  });

  it('translates equity at the HISTORICAL rate', () => {
    const eq = r.translated.find((b) => b.accountNumber === '3000')!;
    expect(eq.naturalBalanceCents).toBe(600_000); // 500,000 × 1.20
  });

  it('books a CTA plug so the translated balance sheet ties exactly', () => {
    // CTA = assets − liab − equity − NI = 1,100,000 − 440,000 − 600,000 − 105,000.
    expect(r.ctaCents).toBe(-45_000);
    const cta = r.translated.find((b) => b.accountNumber === CTA_ACCOUNT_NUMBER)!;
    expect(cta).toBeTruthy();
    expect(cta.accountType).toBe('EQUITY');
    expect(cta.naturalBalanceCents).toBe(-45_000);

    // Fed through the engine, the consolidated balance-check is exactly 0.
    const consolidated = consolidate({ entities: [], balances: r.translated });
    expect(consolidated.totals.balanceCheckCents).toBe(0);
  });
});

describe('single-currency identity', () => {
  it('passes balances through unchanged when functional == reporting (no CTA)', () => {
    const input = eurTB('A');
    const r = translateEntityTB(input, {
      functionalCurrency: 'USD',
      reportingCurrency: 'USD',
      rates: { average: 1, closing: 1, historical: 1 },
    });
    expect(r.translated_applied).toBe(false);
    expect(r.ctaCents).toBe(0);
    expect(r.translated).toHaveLength(input.length); // no CTA line appended
    for (const b of input) {
      const t = r.translated.find((x) => x.accountNumber === b.accountNumber)!;
      expect(t.naturalBalanceCents).toBe(b.naturalBalanceCents);
    }
    // Consolidating translated == consolidating raw (byte-for-byte totals).
    const a = consolidate({ entities: [], balances: input });
    const b = consolidate({ entities: [], balances: r.translated });
    expect(b.totals).toEqual(a.totals);
  });
});

describe('resolveTranslationRates', () => {
  const rows: FxRateRow[] = [
    { fromCurrency: 'EUR', toCurrency: 'USD', rateDate: '2026-03-31', rate: 1.1, rateType: 'CLOSING' },
    { fromCurrency: 'EUR', toCurrency: 'USD', rateDate: '2026-03-15', rate: 1.05, rateType: 'AVERAGE' },
    { fromCurrency: 'EUR', toCurrency: 'USD', rateDate: '2026-01-01', rate: 1.2, rateType: 'SPOT' },
    { fromCurrency: 'GBP', toCurrency: 'USD', rateDate: '2026-03-31', rate: 1.3, rateType: 'CLOSING' },
  ];

  it('picks closing/average/historical for a pair', () => {
    const { rates, resolved } = resolveTranslationRates(rows, 'EUR', 'USD');
    expect(rates.closing).toBe(1.1); // latest CLOSING
    expect(rates.average).toBe(1.05); // latest AVERAGE
    expect(rates.historical).toBe(1.2); // earliest known (2026-01-01 SPOT) as proxy
    expect(resolved).toEqual({ average: true, closing: true, historical: true });
  });

  it('identity pair → all 1.0', () => {
    const { rates } = resolveTranslationRates(rows, 'USD', 'USD');
    expect(rates).toEqual({ average: 1, closing: 1, historical: 1 });
  });

  it('unknown pair → all fall back to 1.0', () => {
    const { rates, resolved } = resolveTranslationRates(rows, 'JPY', 'USD');
    expect(rates).toEqual({ average: 1, closing: 1, historical: 1 });
    expect(resolved).toEqual({ average: false, closing: false, historical: false });
  });
});
