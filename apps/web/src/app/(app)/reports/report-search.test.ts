import { describe, it, expect } from 'vitest';
import { matchCatalogReport, normalizeReportQuery } from './report-search';

const CATALOG = [
  { key: 'financial', reports: [
    { key: 'pnl', label: 'Profit & Loss' },
    { key: 'pnl_month', label: 'P&L by Month' },
    { key: 'pnl_class', label: 'P&L by Class' },
    { key: 'bs', label: 'Balance Sheet' },
    { key: 'tb', label: 'Trial Balance' },
    { key: 'cf', label: 'Cash Flow Statement' },
  ] },
  { key: 'ap', reports: [
    { key: 'ap_aging', label: 'AP Aging' },
    { key: 'exp_vend', label: 'Expense by Vendor' },
  ] },
];

describe('reports sidebar search', () => {
  it('opens a catalog report by name (the L.2 repro: "balance sheet" + Enter)', () => {
    expect(matchCatalogReport('balance sheet', CATALOG)).toMatchObject({ categoryKey: 'financial', reportKey: 'bs' });
  });

  it('understands shorthand', () => {
    expect(matchCatalogReport('P&L', CATALOG)?.reportKey).toBe('pnl');
    expect(matchCatalogReport('income statement', CATALOG)?.reportKey).toBe('pnl');
    expect(matchCatalogReport('pnl by month', CATALOG)?.reportKey).toBe('pnl_month');
    expect(matchCatalogReport('A/P aging', CATALOG)?.reportKey).toBe('ap_aging');
    expect(matchCatalogReport('show me the trial balance', CATALOG)?.reportKey).toBe('tb');
    expect(matchCatalogReport('cash flow', CATALOG)?.reportKey).toBe('cf');
  });

  it('hands free-form requests to the compiler (no match)', () => {
    expect(matchCatalogReport('last three years of P&L and balance sheets on accrual', CATALOG)).toBeNull();
    expect(matchCatalogReport('', CATALOG)).toBeNull();
  });

  it('normalizes punctuation and synonyms', () => {
    expect(normalizeReportQuery('  P & L!! ')).toBe('profit loss');
  });
});
