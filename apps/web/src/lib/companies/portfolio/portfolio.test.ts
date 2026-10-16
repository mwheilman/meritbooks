import { describe, it, expect } from 'vitest';
import { csvToGrid, findTitleDate, parseMoneyCents, parseTbGrid, splitAccountCell, TB_CONVERSION_MAPPING } from './tb-grid';
import { matchTbToCompany, suggestedCompanyName, type CompanyRef } from './company-match';
import { parseCompanyList, parseMonth } from './bulk-parse';
import { deriveStage, nextActionFor, pickSession, statusForStage, statusToSync } from './tower-stage';
import type { TowerSession } from './types';

// ── TB grid ──────────────────────────────────────────────────────────────────

const QB_TB = [
  'Heritage Interiors LLC,,',
  'Trial Balance,,',
  '"As of September 30, 2026",,',
  ',,',
  ',Debit,Credit',
  '10100 Checking,"12,500.00",',
  '12000 Accounts Receivable,3000.10,',
  '20000 Accounts Payable,,"4,000.00"',
  '30000 Opening Balance Equity,,(1.00)',
  '32000 Retained Earnings,,"11,501.10"',
  '40000 Sales,,0.00',
  'TOTAL,"15,501.10","15,501.10"',
  ',,',
  '"Accrual Basis Friday, October 16, 2026 09:12 AM GMT-05:00",,',
].join('\n');

describe('parseTbGrid', () => {
  it('finds the table under QuickBooks title rows with a blank account header', () => {
    const p = parseTbGrid(csvToGrid(QB_TB));
    expect(p.error).toBeNull();
    expect(p.titleLines).toEqual(['Heritage Interiors LLC', 'Trial Balance', 'As of September 30, 2026']);
    expect(p.detectedAsOf).toBe('2026-09-30');
    expect(p.mapping).toEqual(TB_CONVERSION_MAPPING);
    expect(p.rows[0]).toEqual({ Account: '10100', 'Account Name': 'Checking', Debit: '12500.00', Credit: '' });
    // (1.00) in the credit column folds to a 1.00 debit.
    expect(p.rows.find((r) => r.Account === '30000')).toMatchObject({ Debit: '1.00', Credit: '' });
    expect(p.zeroRows).toBe(1);
    expect(p.excluded.some((e) => /TOTAL/.test(e.reason))).toBe(true);
    expect(p.totalDebitCents).toBe(1250000 + 300010 + 100);
    expect(p.totalCreditCents).toBe(400000 + 1150110);
    expect(p.balanced).toBe(true);
  });

  it('reads explicit Account / Name / Balance columns (signed single column)', () => {
    const grid = csvToGrid('Account,Name,Balance\n1000,Cash,500\n2000,Loan,-500\n');
    const p = parseTbGrid(grid);
    expect(p.rows).toEqual([
      { Account: '1000', 'Account Name': 'Cash', Debit: '500.00', Credit: '' },
      { Account: '2000', 'Account Name': 'Loan', Debit: '', Credit: '500.00' },
    ]);
    expect(p.balanced).toBe(true);
  });

  it('does not mistake a "Trial Balance" title for a header', () => {
    const p = parseTbGrid([['', 'Trial Balance'], ['Account', 'Debit', 'Credit'], ['Cash', '5', '']]);
    expect(p.headerRowIndex).toBe(1);
    expect(p.rows).toHaveLength(1);
  });

  it('reports a clear error when there is no Debit/Credit table', () => {
    const p = parseTbGrid([['Customer', 'Email'], ['Acme', 'a@b.c']]);
    expect(p.error).toMatch(/Debit\/Credit/);
  });

  it('auto-detects tab-separated text', () => {
    expect(csvToGrid('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('money + date helpers', () => {
  it('parses exported money formats to exact cents', () => {
    expect(parseMoneyCents('1,234.56')).toBe(123456);
    expect(parseMoneyCents('$1,234.5')).toBe(123450);
    expect(parseMoneyCents('(10.00)')).toBe(-1000);
    expect(parseMoneyCents('10.00-')).toBe(-1000);
    expect(parseMoneyCents('25 CR')).toBe(-2500);
    expect(parseMoneyCents('0.105')).toBe(11);
    expect(parseMoneyCents('')).toBeNull();
    expect(parseMoneyCents('abc')).toBeNull();
  });

  it('finds dates in title lines', () => {
    expect(findTitleDate('As of Sept. 30, 2026')).toBe('2026-09-30');
    expect(findTitleDate('As of 12/31/2025')).toBe('2025-12-31');
    expect(findTitleDate('Period ending 2026-06-30')).toBe('2026-06-30');
    expect(findTitleDate('As of February 30, 2026')).toBeNull();
    expect(findTitleDate('Trial Balance')).toBeNull();
  });

  it('splits "number name" account cells', () => {
    expect(splitAccountCell('10100 · Checking')).toEqual({ number: '10100', name: 'Checking' });
    expect(splitAccountCell('1000-00 - Cash')).toEqual({ number: '1000-00', name: 'Cash' });
    expect(splitAccountCell('Undeposited Funds')).toEqual({ number: null, name: 'Undeposited Funds' });
  });
});

// ── Company matching ─────────────────────────────────────────────────────────

const COMPANIES: CompanyRef[] = [
  { id: 'scc', name: 'Swan Creek Construction', shortCode: 'SCC' },
  { id: 'icc', name: 'Iowa Custom Cabinetry', shortCode: 'ICC' },
  { id: 'hh', name: 'Heartland HVAC', shortCode: 'HH' },
  { id: 'hi', name: 'Heritage Interiors', shortCode: 'HI' },
];

describe('matchTbToCompany', () => {
  it('matches the company named in the title rows with high confidence', () => {
    const m = matchTbToCompany({ fileName: 'export (3).csv', titleLines: ['Heritage Interiors LLC', 'Trial Balance'] }, COMPANIES);
    expect(m.companyId).toBe('hi');
    expect(m.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('matches by company name in the file name', () => {
    const m = matchTbToCompany({ fileName: 'Swan_Creek_Construction_TB_2026-09-30.xlsx', titleLines: [] }, COMPANIES);
    expect(m.companyId).toBe('scc');
    expect(m.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('matches by short code token in the file name', () => {
    const m = matchTbToCompany({ fileName: 'ICC trial balance sept.csv', titleLines: [] }, COMPANIES);
    expect(m.companyId).toBe('icc');
    expect(m.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('tolerates typos via fuzzy similarity', () => {
    const m = matchTbToCompany({ fileName: 'Heartlnd HVAC.csv', titleLines: [] }, COMPANIES);
    expect(m.companyId).toBe('hh');
    expect(m.confidence).toBeLessThan(0.9);
  });

  it('returns no match when nothing lines up', () => {
    const m = matchTbToCompany({ fileName: 'Book1.xlsx', titleLines: ['Trial Balance'] }, COMPANIES);
    expect(m.companyId).toBeNull();
  });

  it('suggests the title company name for a new company', () => {
    expect(suggestedCompanyName(['Prairie Dental PC', 'Trial Balance', 'As of 9/30/2026'])).toBe('Prairie Dental PC');
    expect(suggestedCompanyName(['Trial Balance', 'As of 9/30/2026'])).toBeNull();
  });
});

// ── Bulk company list ────────────────────────────────────────────────────────

describe('parseCompanyList', () => {
  it('treats a plain list as one company per line (commas stay in the name)', () => {
    const r = parseCompanyList('Acme Holdings, LLC\n\n  Swan Creek Construction \n1. Heartland HVAC\n');
    expect(r.rows.map((x) => x.name)).toEqual(['Acme Holdings, LLC', 'Swan Creek Construction', 'Heartland HVAC']);
  });

  it('reads a CSV with a header (name, industry, fiscal year start)', () => {
    const r = parseCompanyList('Company,Industry,Fiscal Year Start\n"Acme, Inc.",Retail,July\nBeta Co,,3\n');
    expect(r.rows).toEqual([
      { name: 'Acme, Inc.', industry: 'Retail', fiscalYearStartMonth: 7, shortCode: null },
      { name: 'Beta Co', industry: null, fiscalYearStartMonth: 3, shortCode: null },
    ]);
  });

  it('reads tab-separated cells pasted from a spreadsheet', () => {
    const r = parseCompanyList('Acme\tRetail\tJan\nBeta\tDental\t');
    expect(r.rows[0]).toMatchObject({ name: 'Acme', industry: 'Retail', fiscalYearStartMonth: 1 });
    expect(r.rows[1]).toMatchObject({ name: 'Beta', industry: 'Dental', fiscalYearStartMonth: null });
  });

  it('drops duplicates and unreadable months with a warning', () => {
    const r = parseCompanyList('Name,FY start\nAcme,Smarch\nacme,1');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].fiscalYearStartMonth).toBeNull();
    expect(r.warnings).toHaveLength(2);
  });

  it('parseMonth handles numbers, names and abbreviations', () => {
    expect(parseMonth('10')).toBe(10);
    expect(parseMonth('sept')).toBe(9);
    expect(parseMonth('FY starts October')).toBe(10);
    expect(parseMonth('')).toBeNull();
    expect(Number.isNaN(parseMonth('13'))).toBe(true);
  });
});

// ── Control Tower stages ─────────────────────────────────────────────────────

function session(p: Partial<TowerSession> = {}): TowerSession {
  return {
    id: 's1', status: 'PROPOSED', asOfDate: '2026-09-30', unmappedCount: 0, unknownTargetCount: 0,
    balanced: true, tiedOut: false, posted: false, postedEntryId: null, createdAt: '2026-10-01T00:00:00Z', ...p,
  };
}

describe('control tower stages', () => {
  it('derives each stage', () => {
    expect(deriveStage(null, false)).toBe('created');
    expect(deriveStage(session({ unmappedCount: 3 }), false)).toBe('uploaded');
    expect(deriveStage(session(), false)).toBe('matched');
    expect(deriveStage(session({ tiedOut: true }), false)).toBe('checked');
    expect(deriveStage(session({ posted: true }), false)).toBe('live');
    expect(deriveStage(null, true)).toBe('live');
  });

  it('maps stages to onboarding status and only ever syncs forward', () => {
    expect(statusForStage('created')).toBe('not_started');
    expect(statusForStage('checked')).toBe('in_progress');
    expect(statusForStage('live')).toBe('complete');
    expect(statusToSync('not_started', 'in_progress')).toBe('in_progress');
    expect(statusToSync('in_progress', 'not_started')).toBeNull();
    expect(statusToSync('complete', 'in_progress')).toBeNull();
    expect(statusToSync('in_progress', 'complete')).toBe('complete');
  });

  it('prefers a posted session, else the newest non-rejected one', () => {
    const a = session({ id: 'a', createdAt: '2026-10-01' });
    const b = session({ id: 'b', createdAt: '2026-10-03', status: 'REJECTED' });
    const c = session({ id: 'c', createdAt: '2026-10-02' });
    expect(pickSession([a, b, c])?.id).toBe('c');
    expect(pickSession([a, session({ id: 'p', posted: true, createdAt: '2026-09-01' })])?.id).toBe('p');
    expect(pickSession([])).toBeNull();
  });

  it('points the next action at the right place', () => {
    expect(nextActionFor({ stage: 'created', session: null, periodsMissing: true, openingEntryId: null }).kind).toBe('repair_periods');
    expect(nextActionFor({ stage: 'created', session: null, periodsMissing: false, openingEntryId: null }).kind).toBe('upload');
    expect(nextActionFor({ stage: 'uploaded', session: session({ id: 'x y' }), periodsMissing: false, openingEntryId: null }).href)
      .toBe('/onboarding/conversion?sessionId=x%20y');
    expect(nextActionFor({ stage: 'live', session: null, periodsMissing: false, openingEntryId: 'e1' }).href).toBe('/journal-entries?entry=e1');
  });
});
