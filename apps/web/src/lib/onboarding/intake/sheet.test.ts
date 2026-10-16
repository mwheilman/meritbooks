import { describe, it, expect } from 'vitest';
import { textToGrid, detectHeaderRow, sniffSheet, readSheetRows } from './sheet';
import { classifyByRules } from './rules';

const QBO_AR = [
  'Heritage Interiors LLC',
  'A/R Aging Summary',
  'As of September 30 2026',
  '',
  'Customer,Current,1 - 30,31 - 60,Total',
  '"Acme, Inc.",1000.00,250.00,,1250.00',
  'Beta Co,500.00,,,500.00',
].join('\n');

describe('textToGrid', () => {
  it('honors quotes, embedded commas and blank lines', () => {
    const g = textToGrid(QBO_AR);
    expect(g[0]).toEqual(['Heritage Interiors LLC']);
    expect(g.find((r) => r[0] === 'Acme, Inc.')).toBeTruthy();
    expect(g.every((r) => r.some((c) => c.trim() !== ''))).toBe(true);
  });

  it('reads TSV', () => {
    expect(textToGrid('a\tb\n1\t2', '\t')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('detectHeaderRow', () => {
  it('skips QuickBooks title rows', () => {
    const g = textToGrid(QBO_AR);
    expect(g[detectHeaderRow(g)][0]).toBe('Customer');
  });
});

describe('sniffSheet + rules (AI off)', () => {
  it('a QuickBooks A/R aging CSV classifies as open A/R from its content alone', () => {
    const sniff = sniffSheet(Buffer.from(QBO_AR, 'utf8'), 'text/csv', 'export.csv');
    expect(classifyByRules({ fileName: 'export.csv', cells: sniff.cells }).docType).toBe('AR_AGING');
  });

  it('a trial balance CSV classifies as a TB', () => {
    const csv = 'Account,Debit,Credit\n1000 Cash,5000,\n3000 Equity,,5000\n';
    const sniff = sniffSheet(Buffer.from(csv), 'text/csv', 'tb.csv');
    expect(classifyByRules({ fileName: 'whatever.csv', cells: sniff.cells }).docType).toBe('TRIAL_BALANCE');
  });
});

describe('readSheetRows', () => {
  it('returns header-keyed rows starting at the real header', () => {
    const parsed = readSheetRows(Buffer.from(QBO_AR), 'text/csv', 'ar.csv');
    expect(parsed.headers).toEqual(['Customer', 'Current', '1 - 30', '31 - 60', 'Total']);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ Customer: 'Acme, Inc.', Total: '1250.00' });
  });

  it('never throws on garbage and returns empty', () => {
    expect(readSheetRows(Buffer.from([0xff, 0x00, 0x13]), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x.xlsx').headers).toEqual([]);
  });
});
