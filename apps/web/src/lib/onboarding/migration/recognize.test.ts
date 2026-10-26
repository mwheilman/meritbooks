import { describe, expect, it } from 'vitest';
import { inferAccountType, normalizePartyName, recognizeGrid } from './recognize';
import type { StagedBankBalance, StagedJob, StagedOpenItem, StagedParty, StagedTbLine } from './types';

const FOOTER = 'Accrual Basis Friday, October 2, 2026 09:12 AM GMT-05:00';

function dataOf<T>(r: ReturnType<typeof recognizeGrid>): T[] {
  return r.records.map((p) => p.data as unknown as T);
}

describe('recognizeGrid — trial balance', () => {
  const qboTb: string[][] = [
    ['Heritage Interiors LLC'],
    ['Trial Balance'],
    ['As of September 30, 2026'],
    [],
    ['', 'Debit', 'Credit'],
    ['1000 Checking', '12,345.67', ''],
    ['1200 Accounts Receivable (A/R)', '6,973.00', ''],
    ['2000 Accounts Payable (A/P)', '', '3,660.50'],
    ['2100 Visa Card', '', '1,000.00'],
    ['3000 Opening Balance Equity', '', '5,000.00'],
    ['4000 Sales', '', '25,000.00'],
    ['5000 Cost of Goods Sold', '10,000.00', ''],
    ['6000 Rent Expense', '5,341.83', ''],
    ['TOTAL', '$34,660.50', '$34,660.50'],
    [],
    [],
    [FOOTER],
  ];

  it('reads a QuickBooks Online TB with title rows, a TOTAL row and a footer', () => {
    const r = recognizeGrid(qboTb, { systemId: 'quickbooks', expectEntity: 'tb_line' });
    expect(r.entity).toBe('tb_line');
    expect(r.parser).toBe('quickbooks.tb v1');
    expect(r.records).toHaveLength(8);
    expect(r.controlTotals.debitCents).toBe(3_466_050);
    expect(r.controlTotals.creditCents).toBe(3_466_050);
    expect(r.controlTotals.differenceCents).toBe(0);
    expect(r.controlTotals.reportDebitCents).toBe(3_466_050);
    expect(r.asOfHint).toBe('2026-09-30');
    expect(r.label).toBe('Trial balance as of Sep 30, 2026 · 8 accounts');
    expect(r.confidence).toBeGreaterThanOrEqual(0.95);
    expect(r.warnings).toEqual([]);

    const lines = dataOf<StagedTbLine>(r);
    expect(lines[0]).toMatchObject({ number: '1000', name: 'Checking', debitCents: 1_234_567, creditCents: 0, type: 'ASSET' });
    expect(lines.find((l) => l.number === '2000')?.type).toBe('LIABILITY');
    expect(lines.find((l) => l.number === '3000')?.type).toBe('EQUITY');
    expect(lines.find((l) => l.number === '4000')?.type).toBe('REVENUE');
    expect(lines.find((l) => l.number === '5000')?.type).toBe('COGS');
    expect(lines.find((l) => l.number === '6000')?.type).toBe('OPEX');

    const rows = r.dropped.map((d) => d.row);
    expect(rows).toEqual([1, 2, 3, 5, 14, 17]);
    expect(r.dropped.find((d) => d.row === 14)?.reason).toMatch(/total row/);
    expect(r.dropped.find((d) => d.row === 17)?.reason).toMatch(/footer/);
    expect(r.dropped.find((d) => d.row === 5)?.reason).toMatch(/Column headings/);
  });

  it('detects QuickBooks from the footer when no systemId is given, and warns when out of balance', () => {
    const off = qboTb.map((row) => [...row]);
    off[5] = ['1000 Checking', '12,345.68', ''];
    const r = recognizeGrid(off);
    expect(r.parser).toBe('quickbooks.tb v1');
    expect(r.controlTotals.differenceCents).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/differ by \$0\.01/);
    expect(r.warnings.join(' ')).toMatch(/TOTAL row/);
  });

  it('rejects a General Ledger detail export with the plain message', () => {
    const gl: string[][] = [
      ['Heritage Interiors LLC'],
      ['General Ledger'],
      ['January - September, 2026'],
      [],
      ['', 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Split', 'Amount', 'Balance'],
      ['Checking'],
      ['', '01/02/2026', 'Deposit', '', 'Ankeny Family Dental', '', 'Sales', '100.00', '100.00'],
      ['', '01/05/2026', 'Expense', '881', 'Menards', '', 'Supplies', '-40.00', '60.00'],
      ['Total for Checking', '', '', '', '', '', '', '$60.00', ''],
    ];
    const r = recognizeGrid(gl, { expectEntity: 'tb_line' });
    expect(r.entity).toBeNull();
    expect(r.records).toEqual([]);
    expect(r.parser).toBe('generic.gl_detail v1');
    expect(r.warnings[0]).toMatch(/General Ledger report/);
  });
});

describe('recognizeGrid — agings', () => {
  const qboAr: string[][] = [
    ['Heritage Interiors LLC'],
    ['A/R Aging Detail'],
    ['As of September 30, 2026'],
    [],
    ['', 'Date', 'Transaction Type', 'Num', 'Customer', 'Due Date', 'Amount', 'Open Balance'],
    ['Current'],
    ['', '09/15/2026', 'Invoice', '1042', 'Ankeny Family Dental', '10/15/2026', '4,860.00', '4,860.00'],
    ['', '09/28/2026', 'Invoice', '1047', 'Patel, R. & S.', '10/28/2026', '1,498.00', '1,498.00'],
    ['Total for Current', '', '', '', '', '', '$6,358.00', '$6,358.00'],
    ['1 - 30 days past due'],
    ['', '08/20/2026', 'Invoice', '1031', 'Grimes Storage LLC', '09/19/2026', '2,245.00', '1,245.00'],
    ['', '09/02/2026', 'Payment', '', 'Waukee Schools', '09/02/2026', '-630.00', '-630.00'],
    ['Total for 1 - 30 days past due', '', '', '', '', '', '$1,615.00', '$615.00'],
    [],
    ['TOTAL', '', '', '', '', '', '$7,973.00', '$6,973.00'],
    [],
    [FOOTER],
  ];

  it('reads a QuickBooks A/R Aging Detail: buckets, Total for rows, an unapplied payment', () => {
    const r = recognizeGrid(qboAr, { systemId: 'quickbooks', expectEntity: 'open_invoice' });
    expect(r.entity).toBe('open_invoice');
    expect(r.parser).toBe('quickbooks.ar_aging v1');
    expect(r.records).toHaveLength(4);
    expect(r.controlTotals.openBalanceCents).toBe(697_300);
    expect(r.controlTotals.count).toBe(4);
    expect(r.controlTotals.reportTotalCents).toBe(697_300);
    expect(r.controlTotals.unappliedCents).toBe(-63_000);
    expect(r.controlTotals.unappliedCount).toBe(1);
    expect(r.asOfHint).toBe('2026-09-30');
    expect(r.label).toBe('A/R aging as of Sep 30, 2026 · 4 open invoices · $6,973.00');

    const items = dataOf<StagedOpenItem>(r);
    expect(items[0]).toEqual({
      docNumber: '1042', party: 'Ankeny Family Dental', date: '2026-09-15', dueDate: '2026-10-15', totalCents: 486_000, balanceCents: 486_000,
    });
    expect(items[2]).toMatchObject({ docNumber: '1031', totalCents: 224_500, balanceCents: 124_500 });
    expect(items[3]).toMatchObject({ docNumber: 'Payment 2026-09-02', party: 'Waukee Schools', balanceCents: -63_000, unapplied: true });

    const reasons = Object.fromEntries(r.dropped.map((d) => [d.row, d.reason]));
    expect(reasons[6]).toMatch(/aging bucket heading/);
    expect(reasons[9]).toMatch(/total row/);
    expect(reasons[10]).toMatch(/aging bucket heading/);
    expect(reasons[13]).toMatch(/total row/);
    expect(reasons[15]).toMatch(/total row/);
    expect(reasons[17]).toMatch(/footer/);
    expect(r.warnings.join(' ')).toMatch(/unapplied/);
  });

  it('files an A/P aging dropped in the A/R slot as A/P, with a plain warning', () => {
    const ap: string[][] = [
      ['AIM Kitchen & Bath'],
      ['A/P Aging Detail'],
      ['As of September 30, 2026'],
      [],
      ['', 'Date', 'Transaction Type', 'Num', 'Vendor', 'Due Date', 'Past Due', 'Amount', 'Open Balance'],
      ['Current'],
      ['', '09/20/2026', 'Bill', 'B-1001', 'Menards', '10/20/2026', '', '812.40', '812.40'],
      ['', '09/25/2026', 'Bill', '7731', 'Ankeny Electric LLC', '10/25/2026', '', '1,200.00', '1,200.00'],
      ['Total for Current', '', '', '', '', '', '', '$2,012.40', '$2,012.40'],
      ['31 - 60 days past due'],
      ['', '07/30/2026', 'Bill', 'B-0977', 'Menards', '08/29/2026', '32', '300.00', '300.00'],
      ['Total for 31 - 60 days past due', '', '', '', '', '', '', '$300.00', '$300.00'],
      ['TOTAL', '', '', '', '', '', '', '$2,312.40', '$2,312.40'],
    ];
    const r = recognizeGrid(ap, { systemId: 'quickbooks', expectEntity: 'open_invoice' });
    expect(r.entity).toBe('open_bill');
    expect(r.parser).toBe('quickbooks.ap_aging v1');
    expect(r.records).toHaveLength(3);
    expect(r.controlTotals.openBalanceCents).toBe(231_240);
    expect(r.warnings[0]).toBe('This looks like an A/P aging, not an A/R aging — we filed it as A/P.');
  });

  it('reads a Xero Aged Payables Detail: contacts as section headings, DMY dates', () => {
    const xero: string[][] = [
      ['Aged Payables Detail'],
      ['Iowa Custom Cabinetry LLC'],
      ['As at 30 September 2026'],
      [],
      ['Invoice Date', 'Invoice Reference', 'Due Date', 'Current', '< 1 Month', '1 Month', '2 Months', 'Older', 'Total'],
      ['Menards'],
      ['15 Sep 2026', 'INV-3381', '15 Oct 2026', '1,250.00', '', '', '', '', '1,250.00'],
      ['20 Aug 2026', 'INV-3302', '19 Sep 2026', '', '410.50', '', '', '', '410.50'],
      ['Total Menards', '', '', '1,250.00', '410.50', '', '', '', '1,660.50'],
      ['Rockler Woodworking'],
      ['01 Jul 2026', '88120', '31 Jul 2026', '', '', '2,000.00', '', '', '2,000.00'],
      ['Total Rockler Woodworking', '', '', '', '', '2,000.00', '', '', '2,000.00'],
      [],
      ['Total', '', '', '1,250.00', '410.50', '2,000.00', '', '', '3,660.50'],
    ];
    const r = recognizeGrid(xero, { systemId: 'xero', expectEntity: 'open_bill' });
    expect(r.entity).toBe('open_bill');
    expect(r.parser).toBe('xero.ap_aging v1');
    expect(r.asOfHint).toBe('2026-09-30');
    expect(r.controlTotals.openBalanceCents).toBe(366_050);
    expect(r.controlTotals.reportTotalCents).toBe(366_050);
    const items = dataOf<StagedOpenItem>(r);
    expect(items.map((i) => i.party)).toEqual(['Menards', 'Menards', 'Rockler Woodworking']);
    expect(items[0]).toMatchObject({ docNumber: 'INV-3381', date: '2026-09-15', dueDate: '2026-10-15', balanceCents: 125_000 });
    expect(r.dropped.find((d) => d.row === 6)?.reason).toMatch(/used as the vendor/);
    expect(r.dropped.find((d) => d.row === 9)?.reason).toMatch(/total row/);
    expect(r.warnings).toEqual([]);
  });
});

describe('recognizeGrid — master data', () => {
  it('reads a vendor list with 1099 tracking and tax IDs', () => {
    const vendors: string[][] = [
      ['AIM Kitchen & Bath'],
      ['Vendor Contact List'],
      [],
      ['Vendor', 'Company name', 'Phone', 'Email', 'Billing address', 'Account #', 'Tax ID', 'Track payments for 1099', 'Open balance'],
      ['Menards', 'Menards Inc', '(515) 555-0100', 'ap@menards.example', '100 Main St, Ankeny IA', '', '39-1234567', 'No', '0.00'],
      ['Ankeny Electric LLC', 'Ankeny Electric', '(515) 555-0111', 'office@ankenyelectric.example', '', '', '47-7654321', 'Yes', '1,200.00'],
      ['Joe Smith Drywall', '', '', '', '', '', '', 'Yes', ''],
      ['Total Comfort Supply', '', '(515) 555-0199', '', '', '', '', 'No', '300.00'],
      ['Menards, Inc.', '', '', '', '', '', '', 'No', ''],
    ];
    const r = recognizeGrid(vendors, { systemId: 'quickbooks', expectEntity: 'vendor' });
    expect(r.entity).toBe('vendor');
    expect(r.parser).toBe('quickbooks.vendors v1');
    expect(r.records).toHaveLength(5);
    const v = dataOf<StagedParty>(r);
    expect(v[0]).toMatchObject({ name: 'Menards', email: 'ap@menards.example', taxId: '39-1234567', is1099: false });
    expect(v[1]).toMatchObject({ name: 'Ankeny Electric LLC', is1099: true, taxId: '47-7654321' });
    expect(v[2]).toMatchObject({ name: 'Joe Smith Drywall', is1099: true, taxId: null });
    expect(v[3].name).toBe('Total Comfort Supply'); // a real vendor, not a total row
    expect(r.controlTotals.openBalanceCents).toBe(150_000);
    expect(r.controlTotals.missingTaxId1099Count).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/1 1099 vendor has no tax ID/);
    expect(r.warnings.join(' ')).toMatch(/1 name appears more than once/);
  });

  it('reads YTD paid from a 1099 summary', () => {
    const r = recognizeGrid(
      [
        ['AIM Kitchen & Bath'],
        ['1099 Contractor Summary'],
        ['January 1 - September 30, 2026'],
        ['Vendor', 'Tax ID', 'Total paid'],
        ['Ankeny Electric LLC', '47-7654321', '18,400.00'],
        ['Joe Smith Drywall', '', '6,250.00'],
        ['TOTAL', '', '24,650.00'],
      ],
      { expectEntity: 'vendor' },
    );
    expect(r.entity).toBe('vendor');
    expect(r.parser).toBe('generic.vendor_1099 v1');
    expect(r.controlTotals.ytdPaidCents).toBe(2_465_000);
    expect(r.asOfHint).toBe('2026-09-30');
    expect(dataOf<StagedParty>(r).every((p) => p.is1099 === true)).toBe(true);
  });

  it('reads a customer list', () => {
    const r = recognizeGrid([
      ['Heritage Interiors LLC'],
      ['Customer Contact List'],
      [],
      ['Customer', 'Company name', 'Street address', 'City', 'State', 'Zip', 'Phone', 'Email', 'Open balance'],
      ['Ankeny Family Dental', 'Ankeny Family Dental PC', '200 SE Delaware Ave', 'Ankeny', 'IA', '50021', '(515) 555-0123', 'billing@afd.example', '4,860.00'],
      ['Patel, R. & S.', '', '14 Oak Ln', 'Waukee', 'IA', '50263', '', 'rs.patel@example.com', '1,498.00'],
    ]);
    expect(r.entity).toBe('customer');
    expect(r.parser).toBe('generic.customers v1');
    expect(r.records).toHaveLength(2);
    expect(dataOf<StagedParty>(r)[0]).toMatchObject({ address: '200 SE Delaware Ave, Ankeny, IA, 50021', phone: '(515) 555-0123' });
    expect(r.controlTotals.openBalanceCents).toBe(635_800);
  });

  it('reads a QuickBooks Products and Services export', () => {
    const r = recognizeGrid([
      ['Product/Service Name', 'Sales Description', 'SKU', 'Type', 'Sales Price / Rate', 'Income Account', 'Purchase Cost'],
      ['Install labor', 'Flooring install, per sq ft', 'LAB-01', 'Service', '3.25', 'Installation Income', ''],
      ['LVP Plank — Oak', 'Luxury vinyl plank', 'LVP-OAK', 'Inventory', '4.10', 'Sales of Product Income', '2.05'],
      ['Freight', '', '', 'Non-inventory', '', 'Sales', ''],
    ]);
    expect(r.entity).toBe('item');
    expect(r.records).toHaveLength(3);
    expect(r.records[1].data).toMatchObject({ name: 'LVP Plank — Oak', sku: 'LVP-OAK', kind: 'Inventory', incomeAccount: 'Sales of Product Income' });
  });

  it('reads a class list', () => {
    const r = recognizeGrid([['Heritage Interiors LLC'], ['Class List'], [], ['Class'], ['Residential'], ['Commercial'], ['Service']], { expectEntity: 'dimension' });
    expect(r.entity).toBe('dimension');
    expect(r.records.map((p) => p.data)).toEqual([
      { name: 'Residential', kind: 'class' },
      { name: 'Commercial', kind: 'class' },
      { name: 'Service', kind: 'class' },
    ]);
    expect(r.dropped.map((d) => d.row)).toEqual([1, 2, 4]);
  });

  it('reads a chart of accounts and stores balances debit-positive', () => {
    const r = recognizeGrid([
      ['Account #', 'Account', 'Type', 'Detail type', 'Description', 'Balance'],
      ['1000', 'Checking', 'Bank', 'Checking', '', '12,345.67'],
      ['1200', 'Accounts Receivable (A/R)', 'Accounts receivable (A/R)', 'AccountsReceivable', '', '6,973.00'],
      ['2000', 'Accounts Payable (A/P)', 'Accounts payable (A/P)', 'AccountsPayable', '', '3,660.50'],
      ['6100', 'Bank Charges', 'Expenses', 'BankCharges', '', '45.00'],
    ]);
    expect(r.entity).toBe('account');
    expect(r.parser).toBe('generic.chart_of_accounts v1');
    const accts = r.records.map((p) => p.data);
    expect(accts[0]).toMatchObject({ number: '1000', type: 'ASSET', balanceCents: 1_234_567 });
    expect(accts[2]).toMatchObject({ number: '2000', type: 'LIABILITY', balanceCents: -366_050 });
    expect(accts[3]).toMatchObject({ type: 'OPEX' });
    expect(r.controlTotals).toMatchObject({ count: 4, assetCount: 2, liabilityCount: 1, opexCount: 1 });
  });
});

describe('recognizeGrid — field systems and bank', () => {
  it('reads an Innergy WIP export (contract + change orders, retainage)', () => {
    const wip: string[][] = [
      ['Innergy — WIP Report'],
      ['Iowa Custom Cabinetry'],
      ['As of 09/30/2026'],
      [],
      ['Job #', 'Job Name', 'Customer', 'Status', 'Contract', 'Change Orders', 'Cost to Date', 'Billed to Date', 'Retainage'],
      ['J-1101', 'Grimes Clinic casework', 'Grimes Health', 'Active', '120,000.00', '8,500.00', '61,240.10', '64,000.00', '6,400.00'],
      ['J-1107', 'Waukee HS library', 'Waukee Schools', 'On hold', '84,500.00', '0.00', '22,010.00', '0.00', ''],
      ['J-1112', 'Patel kitchen', 'Patel, R. & S.', 'Active', '38,900.00', '1,250.00', '30,115.50', '35,000.00', '1,750.00'],
      ['Totals', '', '', '', '243,400.00', '9,750.00', '113,365.60', '99,000.00', '8,150.00'],
    ];
    const r = recognizeGrid(wip, { systemId: 'innergy', expectEntity: 'job', fileName: 'ICC_WIP_2026-09-30.xlsx' });
    expect(r.entity).toBe('job');
    expect(r.parser).toBe('innergy.wip v1');
    expect(r.asOfHint).toBe('2026-09-30');
    expect(r.records).toHaveLength(3);
    expect(r.controlTotals).toMatchObject({
      count: 3,
      contractCents: 25_315_000,
      changeOrdersCents: 975_000,
      costCents: 11_336_560,
      billedCents: 9_900_000,
      retainageCents: 815_000,
    });
    const jobs = dataOf<StagedJob>(r);
    expect(jobs[0]).toMatchObject({ number: 'J-1101', name: 'Grimes Clinic casework', customer: 'Grimes Health', status: 'Active', contractCents: 12_850_000, costCents: 6_124_010, billedCents: 6_400_000 });
    expect(r.dropped.find((d) => d.row === 9)?.reason).toMatch(/total row/);
    expect(r.warnings.join(' ')).toMatch(/Contract column plus Change orders/);
  });

  it('derives under / over billing from an over/(under) column', () => {
    const r = recognizeGrid([
      ['Project #', 'Project', 'Revised Contract', 'Cost to Date', 'Billed to Date', 'Over/(Under) Billing'],
      ['P-1', 'Store remodel', '50,000.00', '20,000.00', '27,000.00', '2,000.00'],
      ['P-2', 'Clinic HVAC', '80,000.00', '40,000.00', '35,000.00', '(5,000.00)'],
    ], { systemId: 'simpro' });
    expect(r.parser).toBe('simpro.wip v1');
    const jobs = dataOf<StagedJob>(r);
    expect(jobs[0]).toMatchObject({ billingsInExcessCents: 200_000, unbilledCents: 0 });
    expect(jobs[1]).toMatchObject({ billingsInExcessCents: 0, unbilledCents: 500_000 });
    expect(r.controlTotals).toMatchObject({ unbilledCents: 500_000, billingsInExcessCents: 200_000 });
  });

  it('reads a bank reconciliation summary table', () => {
    const r = recognizeGrid([
      ['Bank reconciliation summary'],
      ['As of September 30, 2026'],
      ['Bank account', 'GL account', 'Statement date', 'Statement ending balance', 'Reconciled through', 'Uncleared items', 'Uncleared total'],
      ['Operating checking', '1000 Checking', '09/30/2026', '93,446.45', '09/30/2026', '3', '-2,150.00'],
      ['Payroll checking', '1010', '09/30/2026', '12,000.00', '08/31/2026', '0', '0.00'],
    ], { expectEntity: 'bank_balance' });
    expect(r.entity).toBe('bank_balance');
    expect(r.parser).toBe('generic.bank_balances v1');
    expect(r.controlTotals).toMatchObject({ count: 2, statementBalanceCents: 10_544_645, unclearedTotalCents: -215_000 });
    const b = dataOf<StagedBankBalance>(r);
    expect(b[0]).toMatchObject({ label: 'Operating checking', glAccountNumber: '1000', statementDate: '2026-09-30', lastReconciledDate: '2026-09-30', unclearedCount: 3 });
    expect(b[1]).toMatchObject({ glAccountNumber: '1010', lastReconciledDate: '2026-08-31', unclearedTotalCents: 0 });
  });

  it('reads a single-account QuickBooks reconciliation report', () => {
    const r = recognizeGrid([
      ['Heritage Interiors LLC'],
      ['1010 Checking, Period Ending 09/30/2026'],
      ['RECONCILIATION REPORT'],
      ['Reconciled on: 10/05/2026'],
      [],
      ['Summary', '', 'USD'],
      ['Statement beginning balance', '', '84,120.55'],
      ['Checks and payments cleared (41)', '', '-52,004.10'],
      ['Deposits and other credits cleared (12)', '', '61,330.00'],
      ['Statement ending balance', '', '93,446.45'],
      [],
      ['Uncleared transactions as of 09/30/2026', '', '-2,150.00'],
      ['Register balance as of 09/30/2026', '', '91,296.45'],
    ], { systemId: 'quickbooks' });
    expect(r.entity).toBe('bank_balance');
    expect(r.parser).toBe('quickbooks.reconciliation v1');
    expect(r.asOfHint).toBe('2026-09-30');
    expect(r.records[0].data).toMatchObject({ label: '1010 Checking', glAccountNumber: '1010', statementBalanceCents: 9_344_645, statementDate: '2026-09-30', unclearedTotalCents: -215_000 });
  });

  it('returns null with a plain warning for an unknown file', () => {
    const r = recognizeGrid([['Hello', 'World'], ['foo', 'bar']], { expectEntity: 'open_invoice' });
    expect(r.entity).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.records).toEqual([]);
    expect(r.warnings[0]).toMatch(/couldn’t tell what this file is/);
    expect(r.warnings[0]).toMatch(/an A\/R aging/);
  });

  it('returns null for an empty grid', () => {
    expect(recognizeGrid([]).entity).toBeNull();
    expect(recognizeGrid([[''], []]).warnings[0]).toMatch(/empty/);
  });
});

describe('inferAccountType', () => {
  it('uses the source type, then detail type, then strong names, then the number range', () => {
    expect(inferAccountType({ number: '6100', name: 'Bank Charges', sourceType: 'Expense' })).toBe('OPEX');
    expect(inferAccountType({ number: null, name: 'Misc', sourceType: null, detailType: 'UndepositedFunds' })).toBe('ASSET');
    expect(inferAccountType({ number: null, name: 'Interest earned', sourceType: 'Other Income' })).toBe('OTHER');
    expect(inferAccountType({ number: null, name: 'Materials', sourceType: 'Cost of Goods Sold' })).toBe('COGS');
    expect(inferAccountType({ number: null, name: 'Freight', sourceType: 'Direct Costs' })).toBe('COGS');
    expect(inferAccountType({ number: '9999', name: 'Accounts Receivable' })).toBe('ASSET');
    expect(inferAccountType({ number: '2400', name: 'Customer deposits' })).toBe('LIABILITY');
    expect(inferAccountType({ number: '1599', name: 'Accumulated Depreciation' })).toBe('ASSET');
    expect(inferAccountType({ number: null, name: 'Bank charges' })).toBe('OPEX');
    expect(inferAccountType({ number: null, name: 'Prepaid insurance' })).toBe('ASSET');
    expect(inferAccountType({ number: null, name: 'Sales tax payable' })).toBe('LIABILITY');
    expect(inferAccountType({ number: null, name: 'Retained Earnings' })).toBe('EQUITY');
    expect(inferAccountType({ number: null, name: 'Something' })).toBeNull();
  });
});

describe('normalizePartyName', () => {
  it('strips punctuation and company suffixes', () => {
    expect(normalizePartyName('Menards, Inc.')).toBe('menards');
    expect(normalizePartyName('Ankeny Electric L.L.C.')).toBe('ankeny electric');
    expect(normalizePartyName('The Home Depot Co Inc')).toBe('home depot');
    expect(normalizePartyName('Patel, R. & S.')).toBe('patel r and s');
    expect(normalizePartyName('Co')).toBe('co');
  });
});
