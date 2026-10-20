import { describe, expect, it } from 'vitest';
import {
  applyMapping,
  detectHeaderRow,
  footLender,
  footOem,
  looksTabular,
  reconcileMapping,
  splitTotalsRow,
  suggestMapping,
  textToGrid,
  unmappedRequired,
} from './mapping';

describe('suggestMapping (generic header synonyms)', () => {
  it('maps common unit-list headers', () => {
    const m = suggestMapping('UNITS', ['Stock #', 'Serial #', 'Make', 'Model', 'Yr', 'N/U', 'Date Received', 'Dealer Cost']);
    expect(m.serialNumber).toBe('Serial #');
    expect(m.stockNumber).toBe('Stock #');
    expect(m.make).toBe('Make');
    expect(m.model).toBe('Model');
    expect(m.modelYear).toBe('Yr');
    expect(m.condition).toBe('N/U');
    expect(m.receivedDate).toBe('Date Received');
    expect(m.dmsInvoiceCostCents).toBe('Dealer Cost');
  });
  it('maps SN / Serial Number variants and lender columns', () => {
    expect(suggestMapping('UNITS', ['SN']).serialNumber).toBe('SN');
    expect(suggestMapping('UNITS', ['S/N']).serialNumber).toBe('S/N');
    expect(suggestMapping('UNITS', ['Serial Number']).serialNumber).toBe('Serial Number');
    const m = suggestMapping('LENDER_STATEMENT', ['Inv #', 'Serial No', 'Model', 'Orig Bal', 'Curr Bal', 'Interest', 'Code']);
    expect(m.lenderInvoiceNumber).toBe('Inv #');
    expect(m.serialNumber).toBe('Serial No');
    expect(m.originalCents).toBe('Orig Bal');
    expect(m.currentCents).toBe('Curr Bal');
    expect(m.interestCents).toBe('Interest');
    expect(m.lenderCode).toBe('Code');
  });
  it('maps "Invoice No" and never reuses one column twice', () => {
    const m = suggestMapping('LENDER_STATEMENT', ['Invoice No', 'Balance']);
    expect(m.lenderInvoiceNumber).toBe('Invoice No');
    expect(m.currentCents).toBe('Balance');
    const used = Object.values(m).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
  });
  it('flags unmapped required fields', () => {
    const m = suggestMapping('DEALS', ['Deal #', 'Customer']);
    expect(unmappedRequired('DEALS', m).map((f) => f.key)).toEqual(expect.arrayContaining(['saleDate', 'serialNumber', 'salePriceCents']));
  });
  it('drops saved columns that no longer exist', () => {
    const r = reconcileMapping('UNITS', ['Serial'], { serialNumber: 'Serial', model: 'Old Model Col' });
    expect(r.serialNumber).toBe('Serial');
    expect(r.model).toBeNull();
  });
});

describe('detectHeaderRow + text grids', () => {
  it('skips title rows above the table', () => {
    const grid = [['Floor plan statement'], ['As of 09/30/2026'], [], ['Invoice #', 'Serial', 'Model', 'Current Balance'], ['A1', 'S1', 'M', '100.00']];
    expect(detectHeaderRow(grid, 'LENDER_STATEMENT')).toBe(3);
  });
  it('reads a tab-separated table pasted from an email', () => {
    const g = textToGrid('Invoice #\tSerial\tBalance\nA1\tS1\t100.00\nA2\tS2\t50.00\n');
    expect(g[0]).toEqual(['Invoice #', 'Serial', 'Balance']);
    expect(looksTabular(g)).toBe(true);
    expect(looksTabular(textToGrid('Hi, please see attached.\nThanks'))).toBe(false);
  });
  it('applies a mapping to records', () => {
    const cells = applyMapping([{ 'Serial #': ' S1 ', Mdl: 'X' }], { serialNumber: 'Serial #', model: 'Mdl', make: null });
    expect(cells).toEqual([{ serialNumber: 'S1', model: 'X' }]);
  });
});

describe('totals row + footing (AC11)', () => {
  it('lifts a Total row out of the lines and offers it as the footer', () => {
    const raws = [{ Inv: 'A1', Bal: '100.00' }, { Inv: 'A2', Bal: '50.00' }, { Inv: 'Total', Bal: '150.00' }];
    const cells = [{ lenderInvoiceNumber: 'A1', currentCents: '100.00' }, { lenderInvoiceNumber: 'A2', currentCents: '50.00' }, { lenderInvoiceNumber: 'Total', currentCents: '150.00' }];
    const s = splitTotalsRow('LENDER_STATEMENT', raws, cells);
    expect(s.keep).toEqual([0, 1]);
    expect(s.dropped).toEqual([2]);
    expect(s.footer.footerPrincipal).toBe('150.00');
  });
  it('a footing lender statement passes; one that does not foot is rejected', () => {
    const lines = [{ lenderInvoiceNumber: 'A1', currentCents: 10_000 }, { lenderInvoiceNumber: 'A2', currentCents: 5_000 }];
    expect(footLender(lines, { principalCents: 15_000 }).ok).toBe(true);
    const bad = footLender(lines, { principalCents: 15_001, lineCount: 3 });
    expect(bad.ok).toBe(false);
    expect(bad.problems.length).toBe(2);
    expect(footLender(lines, { principalCents: null }).ok).toBe(false);
  });
  it('OEM lines must sum (signed) to the total', () => {
    const lines = [
      { lineType: 'WARRANTY_CREDIT' as const, amountCents: 27_000 },
      { lineType: 'DEBIT' as const, amountCents: -2_000 },
    ];
    expect(footOem(lines, 25_000).ok).toBe(true);
    expect(footOem(lines, 27_000)).toMatchObject({ ok: false, differenceCents: -2_000 });
    expect(footOem(lines, null).ok).toBe(false);
  });
});
