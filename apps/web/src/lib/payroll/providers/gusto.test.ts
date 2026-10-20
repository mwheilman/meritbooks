/**
 * Gusto adapter — mocked fetch. Proves the documented call sequence, integer-cent
 * mapping, token refresh + persistence, PII allow-listing, and degrade-safe
 * behavior when unconfigured. No network.
 */

import { describe, it, expect, vi } from 'vitest';
import { GustoPayrollProvider, GUSTO_API_VERSION, type GustoTokens } from './gusto';
import { gustoFixedCompName, parseGustoGeneralLedger, parseGustoTokens } from './gusto-mappers';
import { PayrollProviderNotConfiguredError } from '../engine/types';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const FRESH: GustoTokens = { accessToken: 'at_1', refreshToken: 'rt_1', expiresAt: NOW + 3_600_000 };
const COMPANY = 'co-uuid';
const PAYROLL = 'pr-uuid';

type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };

/** Route table: first matching [method, regex] returns the response. */
function mockFetch(routes: Array<[string, RegExp, (call: Call) => { status?: number; json?: unknown }]>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const call: Call = {
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const route = routes.find(([m, re]) => m === method && re.test(url));
    if (!route) return new Response('not found', { status: 404 });
    const r = route[2](call);
    const status = r.status ?? 200;
    return new Response(status === 202 || status === 204 ? null : JSON.stringify(r.json ?? {}), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function provider(fetchImpl: typeof fetch, over: Partial<ConstructorParameters<typeof GustoPayrollProvider>[0]> = {}) {
  return new GustoPayrollProvider({
    companyUuid: COMPANY,
    tokens: FRESH,
    environment: 'test',
    clientId: 'cid',
    clientSecret: 'csecret',
    fetchImpl,
    now: () => NOW,
    pollIntervalMs: 0,
    maxPolls: 3,
    ...over,
  });
}

const preparedPayroll = {
  payroll_uuid: PAYROLL,
  version: 'v1',
  employee_compensations: [
    {
      employee_uuid: 'emp-a',
      version: 'ver-a',
      excluded: false,
      payment_method: 'Direct Deposit',
      fixed_compensations: [{ name: 'Bonus', amount: '0.00' }],
      hourly_compensations: [{ name: 'Regular Hours', hours: '40.000', job_uuid: 'job-1' }],
    },
  ],
};

const calculatedPayroll = {
  payroll_uuid: PAYROLL,
  calculated_at: '2026-10-20T12:00:01Z',
  processed: false,
  employee_compensations: [
    {
      employee_uuid: 'emp-a',
      excluded: false,
      gross_pay: '2500.00',
      net_pay: '1890.25',
      taxes: [
        { name: 'Federal Income Tax', employer: false, amount: '300.00' },
        { name: 'Social Security', employer: false, amount: '155.00' },
        { name: 'Medicare', employer: false, amount: '36.25' },
        { name: 'Social Security', employer: true, amount: '155.00' },
        { name: 'Medicare', employer: true, amount: '36.25' },
      ],
      benefits: [{ name: '401k', employee_deduction: '100.00', company_contribution: '50.00' }],
      deductions: [{ name: 'Child support', amount: '18.50' }],
      // PII Gusto may include on other resources must never be mapped:
      ssn: '123-45-6789',
    },
  ],
};

describe('GustoPayrollProvider — not configured', () => {
  it('reports NOT_CONFIGURED without env client credentials and throws on use (no network)', async () => {
    const saved = { id: process.env.GUSTO_CLIENT_ID, secret: process.env.GUSTO_CLIENT_SECRET };
    delete process.env.GUSTO_CLIENT_ID;
    delete process.env.GUSTO_CLIENT_SECRET;
    try {
      const { impl, calls } = mockFetch([]);
      const p = provider(impl, { clientId: undefined, clientSecret: undefined });
      expect(p.isConfigured()).toBe(false);
      expect((await p.status()).state).toBe('NOT_CONFIGURED');
      await expect(p.listEmployees()).rejects.toBeInstanceOf(PayrollProviderNotConfiguredError);
      expect(calls).toHaveLength(0);
    } finally {
      if (saved.id !== undefined) process.env.GUSTO_CLIENT_ID = saved.id;
      if (saved.secret !== undefined) process.env.GUSTO_CLIENT_SECRET = saved.secret;
    }
  });

  it('reports NOT_CONFIGURED when no company tokens are stored', async () => {
    const { impl } = mockFetch([]);
    const st = await provider(impl, { tokens: null }).status();
    expect(st.state).toBe('NOT_CONFIGURED');
    expect(st.detail).not.toMatch(/at_1|rt_1|csecret/);
  });
});

describe('GustoPayrollProvider — preview (prepare → update → calculate → read back)', () => {
  it('follows the documented sequence and maps amounts to integer cents', async () => {
    let polls = 0;
    const { impl, calls } = mockFetch([
      ['GET', /\/payrolls\?processing_statuses=unprocessed/, () => ({
        json: [{ payroll_uuid: PAYROLL, pay_period: { start_date: '2026-10-01', end_date: '2026-10-15' } }],
      })],
      ['PUT', /\/payrolls\/pr-uuid\/prepare$/, () => ({ json: preparedPayroll })],
      ['PUT', /\/payrolls\/pr-uuid$/, () => ({ json: {} })],
      ['PUT', /\/payrolls\/pr-uuid\/calculate$/, () => ({ status: 202 })],
      ['GET', /\/payrolls\/pr-uuid\?include=/, () => {
        polls += 1;
        return { json: polls < 2 ? { ...calculatedPayroll, calculated_at: null } : calculatedPayroll };
      }],
    ]);
    const p = provider(impl);
    const preview = await p.previewRun({
      periodStart: '2026-10-01',
      periodEnd: '2026-10-15',
      payDate: '2026-10-20',
      employees: [{ employeeId: 'emp-a', hours: 40, earnings: [{ type: 'commission', amountCents: 75_050 }] }],
    });

    // Sequence + version header.
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `GET /v1/companies/${COMPANY}/payrolls`,
      `PUT /v1/companies/${COMPANY}/payrolls/${PAYROLL}/prepare`,
      `PUT /v1/companies/${COMPANY}/payrolls/${PAYROLL}`,
      `PUT /v1/companies/${COMPANY}/payrolls/${PAYROLL}/calculate`,
      `GET /v1/companies/${COMPANY}/payrolls/${PAYROLL}`,
      `GET /v1/companies/${COMPANY}/payrolls/${PAYROLL}`,
    ]);
    expect(calls.every((c) => c.headers['X-Gusto-API-Version'] === GUSTO_API_VERSION)).toBe(true);
    expect(calls[0].headers.Authorization).toBe('Bearer at_1');

    // Commission merged as a fixed compensation, in dollars, no float drift.
    const update = calls[2].body as { employee_compensations: Array<{ fixed_compensations: Array<{ name: string; amount: string }>; version: string }> };
    expect(update.employee_compensations[0].version).toBe('ver-a');
    expect(update.employee_compensations[0].fixed_compensations).toEqual(
      expect.arrayContaining([{ name: 'Commission', amount: '750.50' }]),
    );

    const e = preview.employees[0];
    expect(e.grossCents).toBe(250_000);
    expect(e.netCents).toBe(189_025);
    expect(e.employeeTaxCents).toBe(30_000 + 15_500 + 3_625);
    expect(e.employerTaxCents).toBe(15_500 + 3_625);
    expect(e.deductionsCents).toBe(10_000 + 1_850);
    expect(e.benefitsCents).toBe(5_000);
    expect(e.providerRef).toBe(`gusto_payroll:${PAYROLL}`);
    // Gross-to-net identity holds on the provider's figures.
    expect(e.grossCents - e.employeeTaxCents - e.deductionsCents).toBe(e.netCents);
    // PII never crosses the boundary.
    expect(JSON.stringify(preview)).not.toContain('123-45-6789');
  });

  it('submit uses the payroll uuid carried on providerRef and moves to PROCESSING', async () => {
    const { impl, calls } = mockFetch([['PUT', /\/submit$/, () => ({ status: 202 })]]);
    const res = await provider(impl).submitRun({
      periodStart: '2026-10-01',
      periodEnd: '2026-10-15',
      payDate: '2026-10-20',
      preview: {
        employees: [{ employeeId: 'emp-a', grossCents: 1, netCents: 1, employeeTaxCents: 0, employerTaxCents: 0, deductionsCents: 0, benefitsCents: 0, providerRef: `gusto_payroll:${PAYROLL}` }],
        totals: { grossCents: 1, netCents: 1, employeeTaxCents: 0, employerTaxCents: 0, deductionsCents: 0, benefitsCents: 0 },
      },
    });
    expect(res).toEqual({ providerRunId: PAYROLL, status: 'PROCESSING' });
    expect(new URL(calls[0].url).pathname).toBe(`/v1/companies/${COMPANY}/payrolls/${PAYROLL}/submit`);
  });
});

describe('GustoPayrollProvider — OAuth refresh', () => {
  it('refreshes on 401, persists the NEW pair before retrying, and never leaks tokens in errors', async () => {
    let first = true;
    const persisted: GustoTokens[] = [];
    const { impl, calls } = mockFetch([
      ['GET', /\/employees$/, (c) => {
        if (first) {
          first = false;
          return { status: 401 };
        }
        expect(c.headers.Authorization).toBe('Bearer at_2');
        return { json: [{ uuid: 'emp-a', first_name: 'Ana', last_name: 'Ruiz', ssn: '123-45-6789', terminated: false, onboarded: true, jobs: [{ compensations: [{ payment_unit: 'Hour' }] }] }] };
      }],
      ['POST', /\/oauth\/token$/, (c) => {
        expect(c.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt_1', client_id: 'cid' });
        return { json: { access_token: 'at_2', refresh_token: 'rt_2', expires_in: 7200 } };
      }],
    ]);
    const p = provider(impl, { persistTokens: async (t) => void persisted.push(t) });
    const emps = await p.listEmployees();
    expect(persisted).toEqual([{ accessToken: 'at_2', refreshToken: 'rt_2', expiresAt: NOW + (7200 - 60) * 1000 }]);
    expect(emps).toEqual([
      { providerEmployeeId: 'emp-a', displayName: 'Ana Ruiz', status: 'ACTIVE', isContractor: false, departmentName: null, payBasis: 'HOURLY' },
    ]);
    expect(JSON.stringify(emps)).not.toContain('123-45-6789');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('refuses to refresh without a persistence callback (refresh revokes the old token)', async () => {
    const { impl } = mockFetch([['GET', /\/employees$/, () => ({ status: 401 })]]);
    await expect(provider(impl).listEmployees()).rejects.toThrow(/persistTokens/);
  });

  it('proactively refreshes an expired access token', async () => {
    const { impl, calls } = mockFetch([
      ['POST', /\/oauth\/token$/, () => ({ json: { access_token: 'at_9', refresh_token: 'rt_9', expires_in: 7200 } })],
      ['GET', /\/pay_schedules$/, () => ({ json: [{ uuid: 'ps1', frequency: 'Twice per month', custom_name: 'Semi', anchor_pay_date: '2026-10-15' }] })],
    ]);
    const p = provider(impl, { tokens: { ...FRESH, expiresAt: NOW - 1 }, persistTokens: async () => undefined });
    const schedules = await p.listPaySchedules();
    expect(calls[0].method).toBe('POST');
    expect(schedules[0]).toEqual({ providerScheduleId: 'ps1', name: 'Semi', frequency: 'SEMIMONTHLY', anchorPayDate: '2026-10-15' });
  });

  it('status reports NEEDS_REAUTH when Gusto rejects the token after refresh', async () => {
    const { impl } = mockFetch([
      ['GET', new RegExp(`/companies/${COMPANY}$`), () => ({ status: 401 })],
      ['POST', /\/oauth\/token$/, () => ({ status: 401 })],
    ]);
    const st = await provider(impl, { persistTokens: async () => undefined }).status();
    expect(st.state).toBe('NEEDS_REAUTH');
  });
});

describe('GustoPayrollProvider — earnings, documents, journal', () => {
  it('pushes commissions into the unprocessed payroll and rejects unmapped employees', async () => {
    const { impl, calls } = mockFetch([
      ['PUT', /\/prepare$/, () => ({ json: preparedPayroll })],
      ['PUT', /\/payrolls\/pr-uuid$/, () => ({ json: {} })],
    ]);
    const res = await provider(impl).importEarnings({
      payDate: '2026-10-20',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-15',
      providerRunId: PAYROLL,
      lines: [
        { employeeId: 'b1', providerEmployeeId: 'emp-a', employeeName: 'Ana', earningType: 'COMMISSION', amountCents: 120_000, memo: null, sourceRef: 'stmt-1' },
        { employeeId: 'b2', providerEmployeeId: null, employeeName: 'Bo', earningType: 'COMMISSION', amountCents: 5_000, memo: null, sourceRef: 'stmt-2' },
        { employeeId: 'b3', providerEmployeeId: 'emp-zzz', employeeName: 'Cy', earningType: 'BONUS', amountCents: 5_000, memo: null, sourceRef: 'stmt-3' },
      ],
    });
    expect(res.mode).toBe('API');
    expect(res.acceptedCount).toBe(1);
    expect(res.acceptedCents).toBe(120_000);
    expect(res.rejected.map((r) => [r.sourceRef, r.index])).toEqual([['stmt-2', 1], ['stmt-3', 2]]);
    const body = calls[1].body as { employee_compensations: Array<{ employee_uuid: string; fixed_compensations: unknown[] }> };
    expect(body.employee_compensations).toHaveLength(1);
    expect(body.employee_compensations[0].fixed_compensations).toEqual(
      expect.arrayContaining([{ name: 'Commission', amount: '1200.00' }]),
    );
  });

  it('returns pay stub + W-2 retrieval handles (API_PDF), filtered by year', async () => {
    const { impl } = mockFetch([
      ['GET', /\/v1\/employees\/emp-a\/forms$/, () => ({
        json: [
          { uuid: 'f1', name: 'w2', title: 'Form W-2', year: 2025 },
          { uuid: 'f2', name: 'w2', title: 'Form W-2', year: 2024 },
          { uuid: 'f3', name: 'company_direct_deposit', title: 'Direct Deposit Authorization', year: null },
        ],
      })],
    ]);
    const links = await provider(impl).getDocumentLinks({ providerEmployeeId: 'emp-a', providerRunId: PAYROLL, year: 2025 });
    expect(links.map((l) => [l.kind, l.apiPath])).toEqual([
      ['PAYSTUB', `/v1/payrolls/${PAYROLL}/employees/emp-a/pay_stub`],
      ['W2', '/v1/forms/f1/pdf'],
    ]);
  });

  it('requests the GL report, polls, downloads WITHOUT the bearer token, and parses balanced lines', async () => {
    const { impl, calls } = mockFetch([
      ['POST', /\/reports\/general_ledger$/, () => ({ json: { request_uuid: 'req-1' } })],
      ['GET', /\/v1\/reports\/req-1$/, () => ({ json: { status: 'Succeeded', report_urls: ['https://files.example.test/gl.json'] } })],
      ['GET', /files\.example\.test\/gl\.json$/, () => ({
        json: {
          check_date: '2026-10-20',
          data: [{
            data_type: 'Basic',
            headers: ['Account Type', 'Account Description', 'Job', 'Debit', 'Credit'],
            rows: [
              ['RegularWages', 'Regular Wages ', 'Tech', '1760.0', null],
              ['EmployerTax', 'Social Security - employer tax ', 'Tech', '109.12', null],
              ['EmployerTax', 'Medicare - employer tax ', 'Tech', '25.52', null],
              ['DebitNetPay', 'Debit net pay', '', null, '1500.00'],
              ['DebitTax', 'Debit tax', '', null, '394.64'],
            ],
          }],
        },
      })],
    ]);
    const j = await provider(impl).exportJournal(PAYROLL);
    expect(j.totalDebitCents).toBe(189_464);
    expect(j.totalCreditCents).toBe(189_464);
    expect(j.balanced).toBe(true);
    expect(j.lines[0]).toEqual({ accountType: 'RegularWages', description: 'Regular Wages', job: 'Tech', debitCents: 176_000, creditCents: 0 });
    const download = calls.find((c) => c.url.includes('files.example.test'))!;
    expect(download.headers.Authorization).toBeUndefined();
  });
});

describe('Gusto pure mappers', () => {
  it('maps Books earning codes to Gusto fixed compensations', () => {
    expect(gustoFixedCompName('commission')).toBe('Commission');
    expect(gustoFixedCompName('bonus')).toBe('Bonus');
    expect(gustoFixedCompName('salary')).toBeNull();
    expect(gustoFixedCompName('Install Spiff')).toBe('Install Spiff'); // tenant custom type
  });

  it('parses the Vault token JSON and rejects malformed secrets', () => {
    expect(parseGustoTokens(JSON.stringify(FRESH))).toEqual(FRESH);
    expect(parseGustoTokens('not json')).toBeNull();
    expect(parseGustoTokens(JSON.stringify({ accessToken: 'x' }))).toBeNull();
    expect(parseGustoTokens(null)).toBeNull();
  });

  it('an unbalanced GL report is flagged, never forced', () => {
    const j = parseGustoGeneralLedger('p', {
      data: [{ data_type: 'Basic', headers: ['Account Type', 'Account Description', 'Debit', 'Credit'], rows: [['RegularWages', 'W', '10.00', null], ['DebitNetPay', 'N', null, '9.99']] }],
    });
    expect(j.balanced).toBe(false);
  });
});
