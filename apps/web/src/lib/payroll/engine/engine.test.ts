/**
 * Payroll engine — MockPayrollEngine math + resolvePayrollEngine fallback.
 *
 * These lock the deterministic estimate the whole workflow is testable against,
 * and prove that a tenant with no active PAYROLL connection resolves to the Mock
 * engine (no core capability depends on a provider being installed).
 */

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  MockPayrollEngine,
  CheckPayrollEngine,
  resolvePayrollEngine,
  MOCK_EMPLOYEE_TAX_RATE,
  MOCK_EMPLOYER_TAX_RATE,
} from './index';

describe('MockPayrollEngine gross-to-net math (deterministic estimate)', () => {
  const engine = new MockPayrollEngine();

  it('sums earnings to gross and applies the flat estimated rates', async () => {
    const preview = await engine.previewRun({
      periodStart: '2026-01-01',
      periodEnd: '2026-01-15',
      payDate: '2026-01-20',
      employees: [
        { employeeId: 'e1', earnings: [{ type: 'salary', amountCents: 500_000 }] },
      ],
    });

    const e = preview.employees[0];
    expect(e.grossCents).toBe(500_000);
    expect(e.employeeTaxCents).toBe(Math.round(500_000 * MOCK_EMPLOYEE_TAX_RATE)); // 90,000
    expect(e.employerTaxCents).toBe(Math.round(500_000 * MOCK_EMPLOYER_TAX_RATE)); // 45,000
    expect(e.deductionsCents).toBe(0);
    expect(e.benefitsCents).toBe(0);
    // net = gross - employeeTax - deductions
    expect(e.netCents).toBe(500_000 - 90_000 - 0); // 410,000
    expect(e.providerRef).toBe('mock_emp_e1');
  });

  it('adds multiple earning lines into a single gross', async () => {
    const preview = await engine.previewRun({
      periodStart: '2026-01-01',
      periodEnd: '2026-01-15',
      payDate: '2026-01-20',
      employees: [
        {
          employeeId: 'e2',
          hours: 80,
          earnings: [
            { type: 'hourly', amountCents: 320_000 },
            { type: 'overtime', amountCents: 30_000 },
            { type: 'bonus', amountCents: 50_000 },
          ],
        },
      ],
    });
    expect(preview.employees[0].grossCents).toBe(400_000);
  });

  it('totals are the exact sum across employees', async () => {
    const preview = await engine.previewRun({
      periodStart: '2026-01-01',
      periodEnd: '2026-01-15',
      payDate: '2026-01-20',
      employees: [
        { employeeId: 'e1', earnings: [{ type: 'salary', amountCents: 500_000 }] },
        { employeeId: 'e2', earnings: [{ type: 'salary', amountCents: 300_000 }] },
      ],
    });

    expect(preview.totals.grossCents).toBe(800_000);
    expect(preview.totals.employeeTaxCents).toBe(
      Math.round(500_000 * MOCK_EMPLOYEE_TAX_RATE) + Math.round(300_000 * MOCK_EMPLOYEE_TAX_RATE),
    );
    expect(preview.totals.netCents).toBe(
      preview.employees[0].netCents + preview.employees[1].netCents,
    );
    // Balance identity the GL post relies on: net = gross - employeeTax - deductions.
    expect(preview.totals.netCents).toBe(
      preview.totals.grossCents - preview.totals.employeeTaxCents - preview.totals.deductionsCents,
    );
  });

  it('submitRun returns a stable id and PROCESSING; getRunStatus settles to PAID', async () => {
    const preview = await engine.previewRun({
      periodStart: '2026-02-01',
      periodEnd: '2026-02-15',
      payDate: '2026-02-20',
      employees: [{ employeeId: 'e1', earnings: [{ type: 'salary', amountCents: 100_000 }] }],
    });
    const submitted = await engine.submitRun({
      preview,
      periodStart: '2026-02-01',
      periodEnd: '2026-02-15',
      payDate: '2026-02-20',
    });
    expect(submitted.providerRunId).toBe('mock_run_2026-02-01_2026-02-15_2026-02-20');
    expect(submitted.status).toBe('PROCESSING');

    const status = await engine.getRunStatus(submitted.providerRunId);
    expect(status.status).toBe('PAID');
    expect(status.paidAt).toBeTruthy();
  });
});

// --- resolvePayrollEngine fallback -----------------------------------------

/**
 * Minimal chainable Supabase stub: every builder method returns `this`, and
 * `maybeSingle()` resolves the configured result.
 */
function fakeDb(result: { data: unknown; error: unknown }): SupabaseClient {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ['schema', 'from', 'select', 'eq', 'order', 'limit']) {
    builder[m] = chain;
  }
  builder.maybeSingle = async () => result;
  return builder as unknown as SupabaseClient;
}

describe('resolvePayrollEngine', () => {
  it('returns the Mock engine when there is no active PAYROLL connection', async () => {
    const db = fakeDb({ data: null, error: null });
    const engine = await resolvePayrollEngine(db, 'org_1');
    expect(engine.name).toBe('mock');
    expect(engine).toBeInstanceOf(MockPayrollEngine);
  });

  it('returns the Mock engine when the connection read errors (e.g. RLS denies)', async () => {
    const db = fakeDb({ data: null, error: { message: 'permission denied' } });
    const engine = await resolvePayrollEngine(db, 'org_1');
    expect(engine.name).toBe('mock');
  });

  it('falls back to Mock when provider=check but no usable secret is configured', async () => {
    // secret_ref null → apiKey stays null → CheckEngine.isConfigured() is false → Mock.
    const db = fakeDb({
      data: {
        provider: 'check',
        environment: 'test',
        account_handle: 'cmp_123',
        secret_ref: null,
        status: 'active',
      },
      error: null,
    });
    const engine = await resolvePayrollEngine(db, 'org_1');
    expect(engine.name).toBe('mock');
  });
});

// --- CheckPayrollEngine graceful degrade -----------------------------------

describe('CheckPayrollEngine degrades gracefully when unconfigured', () => {
  it('isConfigured() is false without an API key', () => {
    const check = new CheckPayrollEngine({ accountHandle: 'cmp_1', apiKey: null, environment: 'test' });
    expect(check.isConfigured()).toBe(false);
  });

  it('previewRun throws PayrollProviderNotConfiguredError (not a crash) when unconfigured', async () => {
    const check = new CheckPayrollEngine({ accountHandle: null, apiKey: null, environment: 'test' });
    await expect(
      check.previewRun({ periodStart: '2026-01-01', periodEnd: '2026-01-15', payDate: '2026-01-20', employees: [] }),
    ).rejects.toThrow('payroll provider not configured');
  });
});
