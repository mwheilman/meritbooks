import { describe, expect, it } from 'vitest';
import type { PfAccount, PfOpenItem, PfParty, PreflightCheckId, PreflightInput, PreflightResult } from '../types';
import { PREFLIGHT_CHECK_IDS } from '../types';
import { PREFLIGHT_CHECKS, form1099ThresholdCents, normalizeName, rankFindings, runPreflight, summarizePreflight } from './checks';
import { tinFingerprint } from '@/lib/vendors/tin-fingerprint';

// ── Fixture: "Dorrian HVAC", QuickBooks as of Sep 30, 2026 (board O14) ────────────

type AcctSpec = [number: string, name: string, sourceType: string | null, detailType: string | null, balanceCents: number];

const DORRIAN_ACCOUNTS: AcctSpec[] = [
  ['1000', 'Operating checking ••8812', 'Bank', 'Checking', 24_500_000],
  ['1010', 'Payroll checking', 'Bank', 'Checking', 1_200_000],
  ['1200', 'Accounts receivable', 'Accounts Receivable', 'AccountsReceivable', 19_061_460],
  ['1250', 'Undeposited Funds', 'Other Current Asset', 'UndepositedFunds', 1_894_000],
  ['1300', 'Inventory', 'Other Current Asset', 'Inventory', 4_000_000],
  ['1500', 'Vehicles', 'Fixed Asset', 'Vehicles', 21_000_000],
  ['1510', 'Tools and equipment', 'Fixed Asset', 'MachineryAndEquipment', 4_500_000],
  ['1590', 'Accumulated depreciation', 'Fixed Asset', 'AccumulatedDepreciation', -9_800_000],
  ['1900', 'Due from Merit Management Group', 'Other Current Asset', 'OtherCurrentAssets', 500_000],
  ['2000', 'Accounts payable', 'Accounts Payable', 'AccountsPayable', -8_500_000],
  ['2100', 'Sales tax payable', 'Other Current Liability', 'SalesTaxPayable', -421_500],
  ['2200', 'Payroll liabilities', 'Other Current Liability', 'PayrollTaxPayable', -810_000],
  ['2400', 'Customer deposits', 'Other Current Liability', 'OtherCurrentLiabilities', -500_000],
  ['2500', 'Note payable - West Bank', 'Long Term Liabilities', 'NotesPayable', -15_000_000],
  ['3000', 'Opening Balance Equity', 'Equity', 'OpeningBalanceEquity', 0],
  ['3900', 'Retained earnings', 'Equity', 'RetainedEarnings', -33_000_000],
  ['4000', 'Installation revenue', 'Income', 'ServiceFeeIncome', -90_000_000],
  ['4050', 'Equipment deposits', 'Income', 'SalesOfProductIncome', -1_240_000],
  ['5000', 'Cost of goods sold', 'Cost of Goods Sold', 'SuppliesMaterialsCogs', 50_000_000],
  ['6000', 'Rent', 'Expense', 'RentOrLeaseOfBuildings', 6_000_000],
  ['6900', 'Ask My Accountant', 'Expense', 'OtherMiscellaneousServiceCost', 198_000],
  ['6999', 'Uncategorized Expense', 'Expense', 'OtherMiscellaneousServiceCost', 314_520],
];

/** Builds the chart; overrides by account number; "3100 Owner's equity" plugs so the TB balances. */
function accounts(over: Record<string, number> = {}, extra: PfAccount[] = []): PfAccount[] {
  const list: PfAccount[] = DORRIAN_ACCOUNTS.map(([number, name, sourceType, detailType, bal]) => ({
    number,
    name,
    type: null,
    sourceType,
    detailType,
    active: true,
    balanceCents: number in over ? over[number] : bal,
  }));
  list.push(...extra);
  const plug = -list.reduce((s, a) => s + a.balanceCents, 0);
  list.push({ number: '3100', name: 'Owner’s equity', type: null, sourceType: 'Equity', detailType: 'OwnersEquity', active: true, balanceCents: plug });
  return list;
}

const inv = (docNumber: string, party: string, balanceCents: number): PfOpenItem => ({ docNumber, party, balanceCents, date: '2026-09-15' });
const party = (name: string, p: Partial<PfParty> = {}): PfParty => ({ name, email: null, phone: null, taxIdHash: null, hasTaxId: false, is1099: false, ytdPaidCents: 0, ...p })
// H2: parties carry the org-scoped keyed fingerprint (never the id) — the same id gives the same fingerprint.
process.env.TIN_FINGERPRINT_KEY = process.env.TIN_FINGERPRINT_KEY ?? 'test-tin-fingerprint-key-0123456789abcdef';
const tin = (raw: string): Partial<PfParty> => ({ taxIdHash: tinFingerprint('00000000-0000-0000-0000-0000000000f1', raw), hasTaxId: true });;

const LEDGER_INVOICES = [inv('INV-1041', 'Hanson Residence', 4_250_000), inv('INV-1042', 'Westside Dental', 6_890_210), inv('INV-1043', 'Clive Apartments', 7_500_000)];

function dorrian(over: Partial<PreflightInput> = {}): PreflightInput {
  return {
    asOf: '2026-09-30',
    accounts: accounts(),
    tbAvailable: true,
    openInvoices: LEDGER_INVOICES,
    openBills: [inv('B-501', 'Johnstone Supply', -231_875), inv('B-502', 'Allied Ductwork', 3_000_000), inv('B-503', 'Ferguson HVAC', 5_670_675)],
    customers: [
      party('Hanson Residence', { email: 'jhanson@example.com' }),
      party('Westside Dental'),
      party('Clive Apartments'),
      party('Hanson, J.', { email: 'JHanson@example.com ' }),
    ],
    vendors: [
      party('Johnstone Supply', { ...tin('42-1234567') }),
      party('Johnstone Supply Co.'),
      party('Allied Ductwork', { is1099: true, ytdPaidCents: 1_200_000 }),
      party('J. Ruiz Electric', { is1099: true, ytdPaidCents: 980_000 }),
      party('Metro Crane', { is1099: true, ytdPaidCents: 840_000 }),
      party('T&K Sheet Metal', { is1099: true, ytdPaidCents: 840_000 }),
      party('Small Sub LLC', { is1099: true, ytdPaidCents: 150_000 }),
      party('Ferguson HVAC', { ...tin('11-1111111'), ytdPaidCents: 9_000_000 }),
    ],
    bank: [
      {
        label: 'Operating ••8812',
        glAccountNumber: '1000',
        statementBalanceCents: 24_500_000,
        lastReconciledDate: '2026-06-30',
        unclearedTotalCents: 2_231_540,
        oldestUnclearedDate: '2026-08-15',
      },
      { label: 'Payroll ••4410', glAccountNumber: '1010', statementBalanceCents: 1_200_000, lastReconciledDate: '2026-09-30', unclearedTotalCents: 0, oldestUnclearedDate: null },
    ],
    jobs: [],
    evidence: [
      { kind: 'sales_tax', label: 'Iowa sales tax: Aug return + Sep collections', amountCents: 421_500, asOf: '2026-09-30', glAccountNumber: '2100', note: null },
      { kind: 'payroll_liability', label: 'Federal 941 deposit', amountCents: 810_000, asOf: '2026-09-25', glAccountNumber: '2200', note: null },
      { kind: 'depreciation', label: 'Depreciation schedule', amountCents: 648_000, asOf: '2026-05-31', glAccountNumber: null, note: 'Jun–Sep catch-up on 9 vehicles and tools' },
      { kind: 'loan', label: 'West Bank term loan statement', amountCents: 15_000_000, asOf: '2026-09-30', glAccountNumber: '2500', note: null },
    ],
    fieldOpenInvoices: [...LEDGER_INVOICES, inv('FE-2201', 'Hanson Residence', 150_000), inv('FE-2202', 'Westside Dental', 137_000)],
    intercompany: [
      { accountNumber: '1900', accountName: 'Due from Merit Management Group', thisSideCents: 500_000, counterpartyName: 'Merit Management Group', otherSideCents: -500_000 },
    ],
    priorYear: { retainedEarningsCents: 25_000_000, netIncomeCents: 8_000_000 },
    booksClosedThrough: '2026-08-31',
    sourceChangedSincePull: false,
    ...over,
  };
}

/** Every issue fixed in source. */
function cleanDorrian(): PreflightInput {
  return dorrian({
    accounts: accounts({ '1200': 18_640_210, '1250': 0, '6900': 0, '6999': 0, '4050': 0, '2000': -8_670_675 }),
    openBills: [inv('B-502', 'Allied Ductwork', 3_000_000), inv('B-503', 'Ferguson HVAC', 5_670_675)],
    customers: [party('Hanson Residence', { email: 'jhanson@example.com' }), party('Westside Dental'), party('Clive Apartments')],
    vendors: [party('Johnstone Supply', { ...tin('421234567') }), party('Allied Ductwork', { is1099: true, ytdPaidCents: 1_200_000, ...tin('12-3456789') })],
    bank: [{ label: 'Operating ••8812', glAccountNumber: '1000', statementBalanceCents: 24_500_000, lastReconciledDate: '2026-09-30', unclearedTotalCents: 0, oldestUnclearedDate: null }],
    evidence: dorrian().evidence.map((e) => (e.kind === 'depreciation' ? { ...e, asOf: '2026-09-30', amountCents: 0 } : e)),
    fieldOpenInvoices: LEDGER_INVOICES,
  });
}

const EMPTY: PreflightInput = {
  asOf: '2026-09-30',
  accounts: [],
  tbAvailable: false,
  openInvoices: null,
  openBills: null,
  customers: null,
  vendors: null,
  bank: null,
  jobs: null,
  evidence: [],
  fieldOpenInvoices: null,
  intercompany: [],
  priorYear: null,
  booksClosedThrough: null,
  sourceChangedSincePull: false,
};

const byId = (rs: PreflightResult[], id: PreflightCheckId): PreflightResult => {
  const r = rs.find((x) => x.checkId === id);
  if (!r) throw new Error(`missing ${id}`);
  return r;
};
const run = (input: PreflightInput, id: PreflightCheckId): PreflightResult => byId(runPreflight(input), id);

// ── Shape ─────────────────────────────────────────────────────────────────────────

describe('catalog and shape', () => {
  it('has 24 checks in PF order with plain-English names', () => {
    expect(PREFLIGHT_CHECKS.map((c) => c.id)).toEqual([...PREFLIGHT_CHECK_IDS]);
    for (const c of PREFLIGHT_CHECKS) expect(c.name).not.toMatch(/PF-\d/);
    expect(PREFLIGHT_CHECKS.filter((c) => c.blocking).map((c) => c.id)).toEqual(['PF-01', 'PF-02', 'PF-07', 'PF-08', 'PF-10', 'PF-20']);
  });

  it.each<[string, PreflightInput]>([
    ['golden', dorrian()],
    ['clean', cleanDorrian()],
    ['empty', EMPTY],
  ])('always returns exactly 24 results in order (%s)', (_n, input) => {
    const rs = runPreflight(input);
    expect(rs.map((r) => r.checkId)).toEqual([...PREFLIGHT_CHECK_IDS]);
    for (const r of rs) {
      expect(r.name).toBe(PREFLIGHT_CHECKS.find((c) => c.id === r.checkId)?.name);
      expect(Number.isInteger(r.amountCents)).toBe(true);
      expect(r.amountCents).toBeGreaterThanOrEqual(0);
      expect(r.records.sample.length).toBeLessThanOrEqual(5);
      expect(r.title).not.toMatch(/PF-\d/);
      expect(r.message).not.toMatch(/PF-\d/);
      expect(r.fix.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    expect(runPreflight(dorrian())).toEqual(runPreflight(dorrian()));
  });
});

// ── Golden fixture (board O14) ────────────────────────────────────────────────────

describe('Dorrian HVAC golden fixture', () => {
  const rs = runPreflight(dorrian());

  it('matches the board strip severity by severity', () => {
    const sev = Object.fromEntries(rs.map((r) => [r.checkId, r.severity]));
    expect(sev).toEqual({
      'PF-01': 'blocker',
      'PF-02': 'blocker',
      'PF-03': 'warning',
      'PF-04': 'warning',
      'PF-05': 'warning',
      'PF-06': 'passed',
      'PF-07': 'passed',
      'PF-08': 'passed',
      'PF-09': 'warning',
      'PF-10': 'warning',
      'PF-11': 'passed',
      'PF-12': 'passed',
      'PF-13': 'info',
      'PF-14': 'warning',
      'PF-15': 'passed',
      'PF-16': 'passed',
      'PF-17': 'warning',
      'PF-18': 'warning',
      'PF-19': 'not_applicable',
      'PF-20': 'not_applicable',
      'PF-21': 'passed',
      'PF-22': 'passed',
      'PF-23': 'warning',
      'PF-24': 'not_applicable',
    });
  });

  it('matches the board dollars exactly', () => {
    const amt = (id: PreflightCheckId) => byId(rs, id).amountCents;
    expect(amt('PF-01')).toBe(421_250);
    expect(amt('PF-02')).toBe(61_200);
    expect(amt('PF-03')).toBe(1_894_000);
    expect(amt('PF-04')).toBe(314_520);
    expect(amt('PF-05')).toBe(198_000);
    expect(amt('PF-09')).toBe(231_875);
    expect(amt('PF-10')).toBe(2_231_540);
    expect(amt('PF-14')).toBe(3_860_000);
    expect(amt('PF-17')).toBe(648_000);
    expect(amt('PF-18')).toBe(1_240_000);
    expect(amt('PF-23')).toBe(287_000);
  });

  it('PF-01 explains the A/R gap in dollars with the account label', () => {
    const r = byId(rs, 'PF-01');
    expect(r.title).toBe('Receivables don’t match the A/R account');
    expect(r.message).toContain('$186,402.10');
    expect(r.message).toContain('$190,614.60');
    expect(r.message).toContain('$4,212.50');
    expect(r.message).toContain('Sep 30, 2026');
    expect(r.accounts).toEqual(['1200 Accounts receivable']);
    expect(r.records.count).toBe(3);
    expect(r.fix).toContain('one reconciling item');
  });

  it('PF-02 ties A/P with the credit flipped to "owed"', () => {
    const r = byId(rs, 'PF-02');
    expect(r.message).toContain('$84,388.00');
    expect(r.message).toContain('$85,000.00');
    expect(r.accounts).toEqual(['2000 Accounts payable']);
    expect(r.records.sample[0]).toContain('Johnstone Supply'); // the unapplied (negative) item leads
  });

  it('PF-03/04/05 name the holding accounts', () => {
    expect(byId(rs, 'PF-03').title).toBe('Undeposited Funds holds $18,940.00');
    expect(byId(rs, 'PF-04').accounts).toEqual(['6999 Uncategorized Expense']);
    expect(byId(rs, 'PF-05').title).toBe('Ask My Accountant holds $1,980.00');
  });

  it('PF-06/07/08 pass with positive titles', () => {
    expect(byId(rs, 'PF-06').title).toBe('Opening Balance Equity is zero');
    expect(byId(rs, 'PF-07').title).toBe('Debits equal credits');
    expect(byId(rs, 'PF-07').records.count).toBe(23);
    expect(byId(rs, 'PF-08').title).toBe('Retained earnings rolls forward to the cent');
    expect(byId(rs, 'PF-08').message).toContain('$330,000.00');
  });

  it('PF-09 flags the overpaid vendor', () => {
    const r = byId(rs, 'PF-09');
    expect(r.title).toBe('Debit balance on a vendor: Johnstone Supply');
    expect(r.records.sample).toEqual(['Johnstone Supply · $2,318.75 · vendor overpaid']);
  });

  it('PF-10 warns on a 92-day-old reconciliation', () => {
    const r = byId(rs, 'PF-10');
    expect(r.title).toBe('Operating ••8812 last reconciled Jun 30, 2026');
    expect(r.records.count).toBe(1);
    expect(r.message).toContain('$22,315.40');
  });

  it('PF-13 finds the duplicate pairs as info', () => {
    const r = byId(rs, 'PF-13');
    expect(r.title).toBe('2 likely duplicate customers and vendors');
    expect(r.records.sample).toEqual(['Hanson Residence ↔ Hanson, J.', 'Johnstone Supply ↔ Johnstone Supply Co.']);
    expect(r.amountCents).toBe(0);
  });

  it('PF-14 lists the four 1099 vendors without a TIN (2026: $2,000 threshold)', () => {
    const r = byId(rs, 'PF-14');
    expect(r.records.count).toBe(4);
    expect(r.title).toBe('4 vendors paid $2,000+ have no tax ID');
    expect(r.message).toContain('Allied Ductwork, J. Ruiz Electric, Metro Crane and T&K Sheet Metal');
    expect(r.message).toContain('$38,600.00');
    expect(r.records.sample.join()).not.toContain('Small Sub'); // $1,500 is under the 2026 threshold
  });

  it('PF-17 catches depreciation not run since May', () => {
    const r = byId(rs, 'PF-17');
    expect(r.title).toBe('Depreciation not run since May 31, 2026');
    expect(r.message).toContain('$6,480.00');
    expect(r.message).toContain('9 vehicles and tools');
  });

  it('PF-18 flags equipment deposits in revenue', () => {
    const r = byId(rs, 'PF-18');
    expect(r.title).toBe('Equipment deposits booked as revenue');
    expect(r.accounts).toEqual(['4050 Equipment deposits']);
  });

  it('PF-19/20/24 are not applicable with the board copy', () => {
    expect(byId(rs, 'PF-19').title).toBe('No retainage in use');
    expect(byId(rs, 'PF-20').title).toBe('No WIP jobs');
    expect(byId(rs, 'PF-24').title).toBe('USD only');
  });

  it('PF-23 finds the two field invoices that never reached the ledger', () => {
    const r = byId(rs, 'PF-23');
    expect(r.title).toBe('2 field-system invoices never reached the ledger');
    expect(r.records.sample).toEqual([
      'FE-2201 · Hanson Residence · $1,500.00 · only in the field system',
      'FE-2202 · Westside Dental · $1,370.00 · only in the field system',
    ]);
  });

  it('summarizes like the board: 2 blockers · $4,824.50, 9 warnings, 1 info, 9 passed, 3 n/a', () => {
    const s = summarizePreflight(rs, new Set());
    expect(s).toEqual({
      blockers: 2,
      blockerCents: 482_450,
      warnings: 9,
      warningsUndecided: 9,
      info: 1,
      passed: 9,
      notApplicable: 3,
      clear: false,
    });
  });

  it('ranks like the board: blockers, then warnings largest first', () => {
    expect(rankFindings(rs).map((r) => r.checkId).slice(0, 12)).toEqual([
      'PF-01', 'PF-02', 'PF-14', 'PF-10', 'PF-03', 'PF-18', 'PF-17', 'PF-04', 'PF-23', 'PF-09', 'PF-05', 'PF-13',
    ]);
    const tail = rankFindings(rs).slice(12).map((r) => r.severity);
    expect(tail).toEqual([...Array(9).fill('passed'), ...Array(3).fill('not_applicable')]);
  });

  it('never prints raw cents', () => {
    for (const r of rs) {
      const text = `${r.title} ${r.message} ${r.records.sample.join(' ')}`;
      expect(text).not.toMatch(/\b(421250|61200|1894000|3860000|2231540)\b/);
    }
  });
});

// ── Clean books ──────────────────────────────────────────────────────────────────

describe('clean fixture', () => {
  it('has no blockers, warnings or info; every check passed or not applicable', () => {
    const rs = runPreflight(cleanDorrian());
    const bad = rs.filter((r) => !['passed', 'not_applicable'].includes(r.severity));
    expect(bad.map((r) => `${r.checkId} ${r.title}`)).toEqual([]);
    expect(summarizePreflight(rs, new Set()).clear).toBe(true);
    expect(byId(rs, 'PF-01').title).toBe('Receivables match the A/R account to the cent');
    expect(byId(rs, 'PF-02').title).toBe('Payables match the A/P account to the cent');
    expect(byId(rs, 'PF-23').severity).toBe('passed');
  });
});

// ── Missing data → not applicable with drop guidance ─────────────────────────────

describe('missing data', () => {
  const rs = runPreflight(EMPTY);

  it('reports every check not applicable (never a fake pass)', () => {
    expect(rs.every((r) => r.severity === 'not_applicable')).toBe(true);
    expect(summarizePreflight(rs, new Set()).notApplicable).toBe(24);
  });

  it('says exactly what to drop', () => {
    expect(byId(rs, 'PF-01').message).toContain('Drop the A/R aging report as of Sep 30, 2026 to run this check.');
    expect(byId(rs, 'PF-02').message).toContain('Drop the A/P aging report as of Sep 30, 2026');
    expect(byId(rs, 'PF-03').message).toContain('Drop the trial balance as of Sep 30, 2026');
    expect(byId(rs, 'PF-07').message).toContain('Drop the trial balance');
    expect(byId(rs, 'PF-08').message).toContain('Drop last year’s year-end balance sheet');
    expect(byId(rs, 'PF-10').message).toContain('drop the last bank reconciliation report');
    expect(byId(rs, 'PF-13').message).toContain('Drop the customer and vendor lists');
    expect(byId(rs, 'PF-14').message).toContain('Drop the vendor list');
    expect(byId(rs, 'PF-20').message).toContain('Drop the WIP schedule');
    expect(byId(rs, 'PF-23').message).toContain('Connect the field system');
  });

  it('a TB without the aging still says to drop the aging', () => {
    const r = run(dorrian({ openInvoices: null }), 'PF-01');
    expect(r.severity).toBe('not_applicable');
    expect(r.message).toMatch(/^Drop the A\/R aging report as of Sep 30, 2026/);
  });

  it('an aging without a TB says to drop the trial balance', () => {
    const r = run(dorrian({ tbAvailable: false }), 'PF-01');
    expect(r.severity).toBe('not_applicable');
    expect(r.message).toContain('Drop the trial balance');
  });

  it('no cutover date phrases it as "your cutover date"', () => {
    expect(run({ ...EMPTY, asOf: null }, 'PF-01').message).toContain('as of your cutover date');
  });
});

// ── Per-check edge cases ─────────────────────────────────────────────────────────

describe('PF-01 / PF-02', () => {
  it('aging larger than the control explains the other direction', () => {
    const r = run(dorrian({ accounts: accounts({ '1200': 18_000_000 }) }), 'PF-01');
    expect(r.severity).toBe('blocker');
    expect(r.amountCents).toBe(640_210);
    expect(r.message).toContain('The aging shows $6,402.10 more than the A/R account');
  });

  it('open invoices with no A/R account is a blocker for the full aging', () => {
    const accts = accounts().filter((a) => a.number !== '1200');
    const r = run(dorrian({ accounts: accts }), 'PF-01');
    expect(r.severity).toBe('blocker');
    expect(r.amountCents).toBe(18_640_210);
  });

  it('detects A/R by name when the source has no typing', () => {
    const accts: PfAccount[] = [
      { number: '1100', name: 'A/R - trade', type: 'ASSET', sourceType: null, detailType: null, active: true, balanceCents: 100 },
      { number: '3000', name: 'Equity', type: 'EQUITY', sourceType: null, detailType: null, active: true, balanceCents: -100 },
    ];
    const r = run({ ...EMPTY, accounts: accts, tbAvailable: true, openInvoices: [inv('1', 'A', 100)] }, 'PF-01');
    expect(r.severity).toBe('passed');
    expect(r.accounts).toEqual(['1100 A/R - trade']);
  });

  it('no receivables at all is not applicable', () => {
    const accts = accounts().filter((a) => a.number !== '1200');
    expect(run(dorrian({ accounts: accts, openInvoices: [] }), 'PF-01').severity).toBe('not_applicable');
  });
});

describe('PF-06', () => {
  it('warns when Opening Balance Equity is not zero', () => {
    const r = run(dorrian({ accounts: accounts({ '3000': -1_250_000 }) }), 'PF-06');
    expect(r.severity).toBe('warning');
    expect(r.amountCents).toBe(1_250_000);
    expect(r.fix).toContain('controller approves');
  });
});

describe('PF-07', () => {
  it('blocks when debits ≠ credits', () => {
    const accts = accounts();
    accts[0] = { ...accts[0], balanceCents: accts[0].balanceCents + 12_345 };
    const r = run(dorrian({ accounts: accts }), 'PF-07');
    expect(r.severity).toBe('blocker');
    expect(r.amountCents).toBe(12_345);
    expect(r.title).toBe('The trial balance is off by $123.45');
  });
});

describe('PF-08', () => {
  it('blocks when prior-year income was not closed to retained earnings', () => {
    const r = run(dorrian({ priorYear: { retainedEarningsCents: 25_000_000, netIncomeCents: 9_000_000 } }), 'PF-08');
    expect(r.severity).toBe('blocker');
    expect(r.amountCents).toBe(1_000_000);
    expect(r.message).toContain('$340,000.00');
    expect(r.message).toContain('$330,000.00');
  });

  it('handles a prior-year loss', () => {
    const r = run(dorrian({ priorYear: { retainedEarningsCents: 35_000_000, netIncomeCents: -2_000_000 } }), 'PF-08');
    expect(r.severity).toBe('passed');
    expect(r.message).toContain('loss of $20,000.00');
  });
});

describe('PF-09', () => {
  it('flags credit cash, debit A/P, negative inventory and debit deposits', () => {
    const r = run(
      dorrian({ accounts: accounts({ '1010': -50_000, '1300': -20_000, '2400': 30_000 }), openBills: [] }),
      'PF-09',
    );
    expect(r.severity).toBe('warning');
    expect(r.amountCents).toBe(100_000);
    expect(r.accounts).toEqual(['1010 Payroll checking', '1300 Inventory', '2400 Customer deposits']);
    expect(r.title).toBe('3 balances on the wrong side');
  });
});

describe('PF-10', () => {
  it('is a blocker when last reconciled more than 180 days before cutover', () => {
    const bank = dorrian().bank?.map((b) => (b.glAccountNumber === '1000' ? { ...b, lastReconciledDate: '2026-03-01' } : b)) ?? null;
    const r = run(dorrian({ bank }), 'PF-10');
    expect(r.severity).toBe('blocker');
    expect(r.message).toContain('stops Prove balances');
  });

  it('is a blocker when uncleared items are more than 180 days old', () => {
    const bank = [{ label: 'Op', glAccountNumber: '1000', statementBalanceCents: 1, lastReconciledDate: '2026-09-30', unclearedTotalCents: 5_000, oldestUnclearedDate: '2026-01-15' }];
    const r = run(dorrian({ bank }), 'PF-10');
    expect(r.severity).toBe('blocker');
    expect(r.amountCents).toBe(5_000);
  });

  it('warns on uncleared items older than 90 days', () => {
    const bank = [{ label: 'Op', glAccountNumber: '1000', statementBalanceCents: 1, lastReconciledDate: '2026-09-30', unclearedTotalCents: 5_000, oldestUnclearedDate: '2026-06-01' }];
    expect(run(dorrian({ bank }), 'PF-10').severity).toBe('warning');
  });

  it('no reconciliation on record is a warning, not a blocker', () => {
    const bank = [{ label: 'Op', glAccountNumber: '1000', statementBalanceCents: 1, lastReconciledDate: null, unclearedTotalCents: 0, oldestUnclearedDate: null }];
    const r = run(dorrian({ bank }), 'PF-10');
    expect(r.severity).toBe('warning');
    expect(r.records.sample[0]).toContain('no reconciliation on record');
  });
});

describe('PF-11', () => {
  it('warns when the source changed since the pull', () => {
    const r = run(dorrian({ sourceChangedSincePull: true }), 'PF-11');
    expect(r.severity).toBe('warning');
    expect(r.title).toBe('The source changed after we pulled it');
  });

  it('warns on changes dated inside the closed period', () => {
    const evidence = [...dorrian().evidence, { kind: 'books_closed' as const, label: 'JE 98 edited', amountCents: -45_000, asOf: '2026-07-14', glAccountNumber: null, note: null }];
    const r = run(dorrian({ evidence }), 'PF-11');
    expect(r.severity).toBe('warning');
    expect(r.amountCents).toBe(45_000);
    expect(r.message).toContain('closed (through Aug 31, 2026)');
  });

  it('is not applicable without a books-closed date', () => {
    expect(run(dorrian({ booksClosedThrough: null }), 'PF-11').severity).toBe('not_applicable');
  });
});

describe('PF-12', () => {
  it('warns on inactive accounts that still have balances', () => {
    const accts = accounts().map((a) => (a.number === '1300' ? { ...a, active: false } : a));
    const r = run(dorrian({ accounts: accts }), 'PF-12');
    expect(r.severity).toBe('warning');
    expect(r.amountCents).toBe(4_000_000);
    expect(r.accounts).toEqual(['1300 Inventory']);
  });
});

describe('PF-13', () => {
  it('matches on TIN and phone, never across customers and vendors', () => {
    const r = run(
      dorrian({
        customers: [party('Acme Mechanical'), party('Delta Plumbing', { phone: '(515) 555-0100' }), party('Delta Plbg', { phone: '+1 515 555 0100' })],
        vendors: [party('Acme Mechanical'), party('Ruiz Electric', { ...tin('12-3456789') }), party('J Ruiz', { ...tin('123456789') })],
      }),
      'PF-13',
    );
    expect(r.severity).toBe('info');
    expect(r.records.count).toBe(2);
    expect(r.records.sample).toEqual(['Delta Plumbing ↔ Delta Plbg', 'Ruiz Electric ↔ J Ruiz']);
  });

  it('passes with no duplicates', () => {
    expect(run(dorrian({ customers: [party('A')], vendors: [party('B')] }), 'PF-13').severity).toBe('passed');
  });

  it('normalizes entity suffixes and punctuation', () => {
    expect(normalizeName('Johnstone Supply Co.')).toBe('johnstone supply');
    expect(normalizeName('T&K Sheet Metal, L.L.C.')).toBe('t and k sheet metal');
    expect(normalizeName('The Acme Corp')).toBe('acme');
  });
});

describe('PF-14', () => {
  it('uses the $600 threshold before 2026 and $2,000 from 2026', () => {
    expect(form1099ThresholdCents('2025-12-31')).toBe(60_000);
    expect(form1099ThresholdCents('2026-09-30')).toBe(200_000);
    expect(form1099ThresholdCents(null)).toBe(60_000);
    const vendors = [party('Small Sub LLC', { is1099: true, ytdPaidCents: 90_000 })];
    expect(run(dorrian({ asOf: '2025-12-31', vendors }), 'PF-14').severity).toBe('warning');
    expect(run(dorrian({ vendors }), 'PF-14').severity).toBe('passed');
  });
});

describe('PF-15', () => {
  it('warns when sales tax owed differs from the return', () => {
    const evidence = dorrian().evidence.map((e) => (e.kind === 'sales_tax' ? { ...e, amountCents: 400_000 } : e));
    const r = run(dorrian({ evidence }), 'PF-15');
    expect(r.severity).toBe('warning');
    expect(r.amountCents).toBe(21_500);
  });

  it('asks for the return when there is a balance but no return', () => {
    const r = run(dorrian({ evidence: dorrian().evidence.filter((e) => e.kind !== 'sales_tax') }), 'PF-15');
    expect(r.severity).toBe('not_applicable');
    expect(r.message).toContain('Drop the last sales-tax return');
  });
});

describe('PF-16', () => {
  it('warns on payroll liabilities more than 30 days old', () => {
    const evidence = dorrian().evidence.map((e) => (e.kind === 'payroll_liability' ? { ...e, asOf: '2026-07-31' } : e));
    const r = run(dorrian({ evidence }), 'PF-16');
    expect(r.severity).toBe('warning');
    expect(r.amountCents).toBe(810_000);
  });

  it('warns on a payroll balance with no report', () => {
    const r = run(dorrian({ evidence: dorrian().evidence.filter((e) => e.kind !== 'payroll_liability') }), 'PF-16');
    expect(r.severity).toBe('warning');
    expect(r.accounts).toEqual(['2200 Payroll liabilities']);
  });
});

describe('PF-17', () => {
  it('warns on fixed assets with no accumulated depreciation', () => {
    const r = run(dorrian({ accounts: accounts({ '1590': 0 }) }), 'PF-17');
    expect(r.severity).toBe('warning');
    expect(r.title).toBe('Fixed assets with no depreciation');
    expect(r.amountCents).toBe(25_500_000);
  });

  it('is not applicable without fixed assets', () => {
    expect(run(dorrian({ accounts: accounts({ '1500': 0, '1510': 0, '1590': 0 }) }), 'PF-17').severity).toBe('not_applicable');
  });
});

describe('PF-19', () => {
  it('warns when open items carry retainage but there is no retainage account', () => {
    const openInvoices = [...LEDGER_INVOICES, inv('INV-1043-RET', 'Clive Apartments', 750_000)];
    const r = run(dorrian({ openInvoices }), 'PF-19');
    expect(r.severity).toBe('warning');
    expect(r.amountCents).toBe(750_000);
  });

  it('passes when retainage has its own account', () => {
    const extra: PfAccount[] = [{ number: '1210', name: 'Retainage receivable', type: null, sourceType: 'Accounts Receivable', detailType: 'AccountsReceivable', active: true, balanceCents: 0 }];
    expect(run(dorrian({ accounts: accounts({}, extra) }), 'PF-19').severity).toBe('passed');
  });
});

describe('PF-20', () => {
  const wipAccounts: PfAccount[] = [
    { number: '1180', name: 'Costs in excess of billings (unbilled)', type: null, sourceType: 'Other Current Asset', detailType: 'OtherCurrentAssets', active: true, balanceCents: 250_000 },
    { number: '2410', name: 'Billings in excess of costs', type: null, sourceType: 'Other Current Liability', detailType: 'OtherCurrentLiabilities', active: true, balanceCents: -400_000 },
  ];
  const jobs = [
    { number: 'J-1', name: 'Clive Apartments RTUs', costCents: 9_000_000, unbilledCents: 250_000, billingsInExcessCents: 0 },
    { number: 'J-2', name: 'Westside Dental', costCents: 1_000_000, unbilledCents: 0, billingsInExcessCents: 400_000 },
  ];

  it('passes when the schedule ties (cost sits in cost of sales: no WIP asset)', () => {
    expect(run(dorrian({ accounts: accounts({}, wipAccounts), jobs }), 'PF-20').severity).toBe('passed');
  });

  it('blocks when the schedule ≠ GL', () => {
    const off = wipAccounts.map((a) => (a.number === '2410' ? { ...a, balanceCents: -300_000 } : a));
    const r = run(dorrian({ accounts: accounts({}, off), jobs }), 'PF-20');
    expect(r.severity).toBe('blocker');
    expect(r.amountCents).toBe(100_000);
    expect(r.message).toContain('billings in excess is $4,000.00 on the schedule but $3,000.00 in the books');
  });

  it('compares cost to date when a WIP asset exists', () => {
    const extra: PfAccount[] = [
      ...wipAccounts,
      { number: '1170', name: 'Work in progress', type: 'ASSET', sourceType: 'Other Current Asset', detailType: 'OtherCurrentAssets', active: true, balanceCents: 9_500_000 },
    ];
    const r = run(dorrian({ accounts: accounts({}, extra), jobs }), 'PF-20');
    expect(r.severity).toBe('blocker');
    expect(r.amountCents).toBe(500_000);
  });
});

describe('PF-21', () => {
  it('matches a statement by name and warns on the difference', () => {
    const evidence = dorrian().evidence.map((e) => (e.kind === 'loan' ? { ...e, glAccountNumber: null, label: 'West Bank', amountCents: 14_750_000 } : e));
    const r = run(dorrian({ evidence }), 'PF-21');
    expect(r.severity).toBe('warning');
    expect(r.amountCents).toBe(250_000);
    expect(r.accounts).toEqual(['2500 Note payable - West Bank']);
  });

  it('asks for the statement when a loan has a balance but none is on file', () => {
    const r = run(dorrian({ evidence: dorrian().evidence.filter((e) => e.kind !== 'loan') }), 'PF-21');
    expect(r.severity).toBe('not_applicable');
    expect(r.message).toContain('Drop the lender statement as of Sep 30, 2026 for Note payable - West Bank');
  });
});

describe('PF-22', () => {
  it('warns when the two sides do not mirror', () => {
    const r = run(
      dorrian({ intercompany: [{ accountNumber: '1900', accountName: 'Due from Merit Management Group', thisSideCents: 500_000, counterpartyName: 'Merit Management Group', otherSideCents: -450_000 }] }),
      'PF-22',
    );
    expect(r.severity).toBe('warning');
    expect(r.amountCents).toBe(50_000);
    expect(r.records.sample[0]).toBe('1900 Due from Merit Management Group · $5,000.00 here · $4,500.00 on Merit Management Group’s books');
  });

  it('warns while waiting for the other client', () => {
    const r = run(
      dorrian({ intercompany: [{ accountNumber: '2900', accountName: 'Due to Swan Creek', thisSideCents: -80_000, counterpartyName: 'Swan Creek', otherSideCents: null }] }),
      'PF-22',
    );
    expect(r.severity).toBe('warning');
    expect(r.title).toBe('Waiting for Swan Creek’s books');
  });

  it('is not applicable without intercompany balances', () => {
    expect(run(dorrian({ intercompany: [] }), 'PF-22').severity).toBe('not_applicable');
  });
});

describe('PF-23', () => {
  it('reports ledger-only and different balances, only for the same customers', () => {
    const field = [inv('INV-1041', 'Hanson Residence', 4_200_000)];
    const ledger = [...LEDGER_INVOICES, inv('INV-1044', 'Hanson Residence', 10_000)];
    const r = run(dorrian({ fieldOpenInvoices: field, openInvoices: ledger }), 'PF-23');
    expect(r.severity).toBe('warning');
    // INV-1041 differs by $500; INV-1044 only in ledger ($100); Westside/Clive aren't field customers.
    expect(r.amountCents).toBe(60_000);
    expect(r.records.count).toBe(2);
  });
});

describe('PF-24', () => {
  it('reports foreign balances as info', () => {
    const evidence = [...dorrian().evidence, { kind: 'currency' as const, label: 'Canadian supplier account', amountCents: 120_000, asOf: null, glAccountNumber: null, note: 'CAD' }];
    const r = run(dorrian({ evidence }), 'PF-24');
    expect(r.severity).toBe('info');
    expect(r.title).toBe('Balances in CAD');
  });

  it('USD notes are not foreign', () => {
    const evidence = [{ kind: 'currency' as const, label: 'Home currency', amountCents: null, asOf: null, glAccountNumber: null, note: 'USD' }];
    expect(run(dorrian({ evidence }), 'PF-24').severity).toBe('not_applicable');
  });
});

// ── Summary semantics ────────────────────────────────────────────────────────────

describe('summarizePreflight', () => {
  const rs = runPreflight(dorrian());
  const warnings = rs.filter((r) => r.severity === 'warning').map((r) => r.checkId);

  it('is not clear while a blocker is unresolved, even with every warning decided', () => {
    const s = summarizePreflight(rs, new Set<PreflightCheckId>(['PF-01', ...warnings]));
    expect(s.warningsUndecided).toBe(0);
    expect(s.clear).toBe(false);
  });

  it('is clear when both blockers are resolved and every warning decided; info never holds it', () => {
    const s = summarizePreflight(rs, new Set<PreflightCheckId>(['PF-01', 'PF-02', ...warnings]));
    expect(s.clear).toBe(true);
    expect(s.blockers).toBe(2); // counts still report what was found
  });

  it('counts undecided warnings', () => {
    expect(summarizePreflight(rs, new Set<PreflightCheckId>(['PF-01', 'PF-02', 'PF-03'])).warningsUndecided).toBe(8);
  });
});
