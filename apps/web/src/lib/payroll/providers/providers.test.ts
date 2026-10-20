/**
 * Provider seam — File adapter (any payroll system), earnings CSV, Mock journal,
 * registry, and the cents helpers. Pure / no network.
 */

import { describe, it, expect } from 'vitest';
import { FilePayrollProvider } from './file';
import { MockPayrollEngine } from './mock';
import { renderEarningsCsv, validateEarningsLines } from './earnings';
import { createPayrollProvider, listPayrollProviders, PAYROLL_PROVIDER_REGISTRY } from './registry';
import {
  PAYROLL_PROVIDER_IDS,
  PayrollCapabilityUnsupportedError,
  centsToDecimal,
  decimalToCents,
  type EarningsLine,
  type PayrollProvider,
} from './types';

const line = (over: Partial<EarningsLine> = {}): EarningsLine => ({
  employeeId: 'emp-1',
  providerEmployeeId: 'ADP-0042',
  employeeName: 'Dana Tech',
  earningType: 'COMMISSION',
  amountCents: 123_456,
  memo: 'Oct installs (14 jobs)',
  sourceRef: 'stmt-2026-10-emp-1',
  ...over,
});

const period = { payDate: '2026-10-31', periodStart: '2026-10-01', periodEnd: '2026-10-31' };

describe('decimalToCents / centsToDecimal — integer-exact', () => {
  it('parses provider dollar strings without float drift', () => {
    expect(decimalToCents('1234.56')).toBe(123_456);
    expect(decimalToCents('0.1')).toBe(10);
    expect(decimalToCents('1760.0')).toBe(176_000);
    expect(decimalToCents('-12.5')).toBe(-1_250);
    expect(decimalToCents('1,200.00')).toBe(120_000);
    expect(decimalToCents(19.99)).toBe(1_999);
    expect(decimalToCents(null)).toBe(0);
    expect(decimalToCents('abc')).toBe(0);
    expect(decimalToCents('.')).toBe(0);
  });

  it('formats cents for request bodies', () => {
    expect(centsToDecimal(75_050)).toBe('750.50');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(-1_250)).toBe('-12.50');
  });
});

describe('validateEarningsLines', () => {
  it('rejects duplicates, non-integer / non-positive cents, and blank refs', () => {
    const { valid, rejected } = validateEarningsLines([
      line(),
      line(), // duplicate sourceRef
      line({ sourceRef: 'a', amountCents: 10.5 }),
      line({ sourceRef: 'b', amountCents: -500 }),
      line({ sourceRef: '' }),
      line({ sourceRef: 'c', employeeId: ' ' }),
    ]);
    expect(valid).toHaveLength(1);
    expect(rejected.map((r) => r.index)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('renderEarningsCsv — provider-neutral earnings file', () => {
  it('writes dollars with integer math and neutralizes formula injection', () => {
    const f = renderEarningsCsv(period, [line({ employeeName: '=HYPERLINK("x")', memo: 'a, b' })]);
    const [header, row] = f.content.trim().split('\r\n');
    expect(header).toBe('employee_id,provider_employee_id,employee_name,earning_type,amount,pay_date,period_start,period_end,memo,source_ref');
    expect(row).toContain(',1234.56,');
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
    expect(row).toContain('"a, b"');
    expect(f.filename).toBe('earnings-2026-10-31.csv');
  });

  it('honors a tenant template (column names + earning codes)', () => {
    const f = renderEarningsCsv(period, [line()], {
      headerOverrides: { provider_employee_id: 'File #', amount: 'Earnings Amount', earning_type: 'Earnings Code' },
      earningTypeLabels: { COMMISSION: 'C' },
    });
    expect(f.content.split('\r\n')[0]).toContain('File #');
    expect(f.content.split('\r\n')[1]).toContain(',C,');
  });

  it('rejects malformed dates instead of writing a bad file', () => {
    expect(() => renderEarningsCsv({ ...period, payDate: '10/31/2026' }, [line()])).toThrow(RangeError);
  });
});

describe('FilePayrollProvider — any payroll system works today', () => {
  const p = new FilePayrollProvider({ systemName: 'ADP Workforce Now', employeePortalUrl: 'https://portal.example.test' });

  it('advertises register import + earnings export, never runs payroll', async () => {
    expect(p.capabilities.runPayroll).toBe(false);
    expect(p.capabilities.registerImport).toBe(true);
    expect((await p.status()).state).toBe('CONNECTED');
    await expect(
      p.previewRun({ periodStart: '2026-10-01', periodEnd: '2026-10-15', payDate: '2026-10-20', employees: [] }),
    ).rejects.toBeInstanceOf(PayrollCapabilityUnsupportedError);
  });

  it('exports earnings as a CSV (mode FILE) and reports rejects', async () => {
    const res = await p.importEarnings({ ...period, lines: [line(), line({ sourceRef: 'x', amountCents: 0 })] });
    expect(res.mode).toBe('FILE');
    expect(res.acceptedCount).toBe(1);
    expect(res.acceptedCents).toBe(123_456);
    expect(res.rejected).toHaveLength(1);
    expect(res.file?.filename).toBe('adp-workforce-now-earnings-2026-10-31.csv');
  });

  it('imports a register through the existing deterministic importer', () => {
    const csv = [
      'Employee,Gross Pay,Federal Income Tax,State Income Tax,Social Security,Medicare,401k,Net Pay,Employer FICA',
      'Dana,"2,000.00",200.00,80.00,124.00,29.00,100.00,1467.00,153.00',
      'Eli,1000.00,90.00,40.00,62.00,14.50,0,793.50,76.50',
    ].join('\n');
    const r = p.importRegisterText(csv, { payDate: '2026-10-31', periodStart: '2026-10-16', periodEnd: '2026-10-31' });
    expect(r.aggregated.grossCents).toBe(300_000);
    expect(r.aggregated.netCents).toBe(226_050);
    expect(r.normalized.payDate).toBe('2026-10-31');
    expect(r.aggregated.employeeCount).toBe(2);
  });

  it('links pay stubs / W-2s to the outside portal when configured', async () => {
    const links = await p.getDocumentLinks({ providerEmployeeId: 'ADP-0042', year: 2025 });
    expect(links[0]).toMatchObject({ retrieval: 'PROVIDER_PORTAL', url: 'https://portal.example.test' });
  });
});

describe('MockPayrollEngine — full provider contract', () => {
  it('produces a balanced journal for a submitted run', async () => {
    const m = new MockPayrollEngine();
    const preview = await m.previewRun({
      periodStart: '2026-10-01',
      periodEnd: '2026-10-15',
      payDate: '2026-10-20',
      employees: [{ employeeId: 'e1', earnings: [{ type: 'commission', amountCents: 333_333 }] }],
    });
    const { providerRunId } = await m.submitRun({ preview, periodStart: '2026-10-01', periodEnd: '2026-10-15', payDate: '2026-10-20' });
    const j = await m.exportJournal(providerRunId);
    expect(j.balanced).toBe(true);
    expect(j.totalDebitCents).toBe(preview.totals.grossCents + preview.totals.employerTaxCents);
  });
});

describe('registry', () => {
  it('registers every provider id with a factory whose id matches', () => {
    for (const id of PAYROLL_PROVIDER_IDS) {
      const p: PayrollProvider = PAYROLL_PROVIDER_REGISTRY[id].create({
        provider: id,
        environment: 'test',
        accountHandle: null,
        secret: null,
        metadata: null,
      });
      expect(p.id).toBe(id);
      expect(p.name).toBe(id);
      expect(p.capabilities).toEqual(PAYROLL_PROVIDER_REGISTRY[id].capabilities);
    }
  });

  it('lists Gusto first (Owner: likely first provider) and returns null for unknown providers', () => {
    expect(listPayrollProviders()[0].id).toBe('gusto');
    expect(createPayrollProvider({ provider: 'nope', environment: 'test', accountHandle: null, secret: null, metadata: null })).toBeNull();
  });

  it('builds the file adapter from connection metadata', () => {
    const p = createPayrollProvider({
      provider: 'file',
      environment: 'live',
      accountHandle: null,
      secret: null,
      metadata: { systemName: 'Paychex Flex' },
    });
    expect(p?.displayName).toBe('Paychex Flex (file import)');
  });

  it('an API adapter built without credentials is NOT configured (and says so)', async () => {
    const g = createPayrollProvider({ provider: 'gusto', environment: 'test', accountHandle: 'co', secret: null, metadata: null })!;
    expect(g.isConfigured()).toBe(false);
    expect((await g.status()).state).toBe('NOT_CONFIGURED');
  });
});

describe('MockPayrollEngine — production release gate (L6)', () => {
  it('blocks release on a Vercel production deploy', async () => {
    const { assertMockReleaseAllowed, MockPayrollInProductionError } = await import('./mock');
    expect(() => assertMockReleaseAllowed({ VERCEL_ENV: 'production' })).toThrow(MockPayrollInProductionError);
  });
  it('allows preview/dev and the explicit demo override', async () => {
    const { assertMockReleaseAllowed } = await import('./mock');
    expect(() => assertMockReleaseAllowed({ VERCEL_ENV: 'preview' })).not.toThrow();
    expect(() => assertMockReleaseAllowed({})).not.toThrow();
    expect(() => assertMockReleaseAllowed({ VERCEL_ENV: 'production', PAYROLL_MOCK_ALLOWED: 'true' })).not.toThrow();
  });
});

describe('earnings CSV — formula injection with leading whitespace (L5)', () => {
  it('prefixes a cell whose first non-blank char is a formula trigger', () => {
    const file = renderEarningsCsv(
      { payDate: '2026-10-30', periodStart: '2026-10-01', periodEnd: '2026-10-15' },
      [{ employeeId: "e1", providerEmployeeId: null, employeeName: "  =HYPERLINK(\"x\")", earningType: "commission" as never, amountCents: 100, memo: null, sourceRef: "r1" }],
    );
    expect(file.content).not.toMatch(/(^|,)"?\s+=HYPERLINK/m);
    expect(file.content).toContain("'  =HYPERLINK");
  });
});
