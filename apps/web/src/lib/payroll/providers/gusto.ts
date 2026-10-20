/**
 * GustoPayrollProvider — adapter SKELETON for Gusto Embedded Payroll
 * (https://docs.gusto.com/embedded-payroll). Owner decision: Gusto is the likely
 * first payroll provider. Gusto is the regulated party: it computes gross-to-net,
 * moves the money, remits and files. Books posts the GL and reconciles.
 *
 * ENDPOINTS (verified against docs.gusto.com guides, API version 2026-06-15):
 *   Auth      POST /oauth/token  grant_type=system_access | authorization_code | refresh_token
 *             Access tokens expire after 2h; refreshing REVOKES the prior refresh token,
 *             so the new pair must be persisted (Vault rotate) before reuse.
 *   Version   header X-Gusto-API-Version: 2026-06-15 (all paths stay /v1)
 *   Payrolls  GET  /v1/companies/{company_uuid}/payrolls?processing_statuses=unprocessed&start_date&end_date
 *             PUT  /v1/companies/{company_uuid}/payrolls/{payroll_uuid}/prepare   → version + employee_compensations
 *             PUT  /v1/companies/{company_uuid}/payrolls/{payroll_uuid}           → update compensations
 *             PUT  /v1/companies/{company_uuid}/payrolls/{payroll_uuid}/calculate → 202 (async)
 *             GET  /v1/companies/{company_uuid}/payrolls/{payroll_uuid}?include=taxes,benefits,deductions
 *                  (poll until calculated_at is set; then `totals` + per-employee amounts)
 *             PUT  /v1/companies/{company_uuid}/payrolls/{payroll_uuid}/submit    → 202, moves money
 *   Roster    GET  /v1/companies/{company_uuid}/employees
 *   Schedules GET  /v1/companies/{company_uuid}/pay_schedules
 *   Earnings  fixed_compensations names "Bonus" / "Commission" / "Correction Payment" / tips,
 *             custom types via POST /v1/companies/{company_uuid}/earning_types
 *   Docs      GET  /v1/payrolls/{payroll_uuid}/employees/{employee_uuid}/pay_stub (PDF)
 *             GET  /v1/employees/{employee_uuid}/forms → GET /v1/forms/{form_uuid}/pdf (W-2)
 *   GL report POST /v1/payrolls/{payroll_uuid}/reports/general_ledger → request_uuid
 *             GET  /v1/reports/{request_uuid} → report URL when ready (JSON rows, dollars)
 *
 * Fields marked TODO(gusto-sandbox) are response-field names to confirm against a
 * live sandbox before go-live; the request paths above are from Gusto's docs.
 *
 * SECURITY / PII:
 *   - OAuth app credentials come from env GUSTO_CLIENT_ID / GUSTO_CLIENT_SECRET
 *     (server-only). Per-company tokens are a Vault secret (core.provider_connections
 *     .secret_ref, migration 041) holding JSON {accessToken, refreshToken, expiresAt}.
 *     Tokens are NEVER logged, serialized into errors, or returned.
 *   - Gusto responses contain PII (SSN, addresses, bank data). Every mapper below
 *     reads ALLOW-LISTED fields only; nothing else crosses into Books.
 *   - Pay stubs / W-2s contain PII: returned as API_PDF handles for a server proxy
 *     to stream, never stored.
 *
 * DEGRADE-SAFE: without env credentials + company tokens, isConfigured() is false,
 * status() reports NOT_CONFIGURED, and every API method throws
 * PayrollProviderNotConfiguredError — never a crash, never fake numbers.
 */

import {
  PayrollProviderNotConfiguredError,
  type EmployeePayInput,
  type PayrollEarning,
  type PayrollRunPreview,
  type SubmitRunInput,
} from '../engine/types';
import {
  decimalToCents,
  centsToDecimal,
  type ImportEarningsInput,
  type ImportEarningsResult,
  type PayrollJournalExport,
  type PayrollProvider,
  type PayrollProviderCapabilities,
  type ProviderConnectionStatus,
  type ProviderDocumentLink,
  type ProviderEmployee,
  type ProviderPaySchedule,
  type PtoBalance,
} from './types';
import { validateEarningsLines } from './earnings';
import {
  EXTERNAL_TO_GUSTO,
  gustoFixedCompName,
  mapGustoPayrollToPreview,
  normalizeGustoFrequency,
  parseGustoGeneralLedger,
  type GustoEmployeeCompensation,
  type GustoGlReport,
  type GustoPayrollDetail,
  type GustoPayrollSummary,
  type GustoTokens,
} from './gusto-mappers';

export { parseGustoTokens, gustoFixedCompName, mapGustoPayrollToPreview, parseGustoGeneralLedger } from './gusto-mappers';
export type { GustoTokens } from './gusto-mappers';

export const GUSTO_API_VERSION = '2026-06-15';
export const GUSTO_DEMO_BASE_URL = 'https://api.gusto-demo.com';
export const GUSTO_PROD_BASE_URL = 'https://api.gusto.com';

export const GUSTO_CAPABILITIES: PayrollProviderCapabilities = Object.freeze({
  runPayroll: true,
  employeeSync: true,
  paySchedules: true,
  documents: true,
  journalExport: true,
  earningsImport: true,
  ptoBalances: true,
  registerImport: false,
});

export interface GustoProviderConfig {
  /** Gusto company_uuid (core.provider_connections.account_handle). Not a secret. */
  companyUuid: string | null;
  tokens: GustoTokens | null;
  environment: 'test' | 'live';
  /** OAuth app credentials — default from env GUSTO_CLIENT_ID / GUSTO_CLIENT_SECRET. */
  clientId?: string | null;
  clientSecret?: string | null;
  /** Override base URL (else env GUSTO_API_BASE_URL, else demo/prod by environment). */
  baseUrl?: string;
  /** Persist a refreshed token pair (server: rotateProviderSecret). Required for refresh. */
  persistTokens?: (tokens: GustoTokens) => Promise<void>;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch ms) for tests. */
  now?: () => number;
  /** Async-calculation polling (calculate / GL report). */
  pollIntervalMs?: number;
  maxPolls?: number;
}

class GustoHttpError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
  ) {
    // Deliberately excludes headers/body (could echo a token).
    super(`Gusto API ${method} ${path} failed: ${status}`);
    this.name = 'GustoHttpError';
  }
}

// ── The adapter ──────────────────────────────────────────────────────────────────

export class GustoPayrollProvider implements PayrollProvider {
  readonly name = 'gusto';
  readonly id = 'gusto' as const;
  readonly displayName = 'Gusto';
  readonly capabilities = GUSTO_CAPABILITIES;

  private readonly companyUuid: string | null;
  private tokens: GustoTokens | null;
  private readonly environment: 'test' | 'live';
  private readonly clientId: string | null;
  private readonly clientSecret: string | null;
  private readonly baseUrl: string;
  private readonly persistTokens?: (t: GustoTokens) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;

  constructor(config: GustoProviderConfig) {
    this.companyUuid = config.companyUuid;
    this.tokens = config.tokens;
    this.environment = config.environment;
    this.clientId = config.clientId ?? process.env.GUSTO_CLIENT_ID ?? null;
    this.clientSecret = config.clientSecret ?? process.env.GUSTO_CLIENT_SECRET ?? null;
    this.baseUrl = (
      config.baseUrl ??
      process.env.GUSTO_API_BASE_URL ??
      (config.environment === 'live' ? GUSTO_PROD_BASE_URL : GUSTO_DEMO_BASE_URL)
    ).replace(/\/$/, '');
    this.persistTokens = config.persistTokens;
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
    this.now = config.now ?? (() => Date.now());
    this.pollIntervalMs = config.pollIntervalMs ?? 1_500;
    this.maxPolls = config.maxPolls ?? 20;
  }

  /** OAuth app creds + company + tokens all present. No network. */
  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.companyUuid && this.tokens);
  }

  private ensureConfigured(): { companyUuid: string } {
    if (!this.isConfigured()) {
      throw new PayrollProviderNotConfiguredError(
        'payroll provider not configured: Gusto client id/secret (env), company uuid, or company tokens missing',
      );
    }
    return { companyUuid: this.companyUuid! };
  }

  // ── OAuth ───────────────────────────────────────────────────────────────────

  /** Authorization-code URL for the "Connect Gusto" button (existing Gusto companies). */
  buildAuthorizeUrl(redirectUri: string, state: string): string {
    if (!this.clientId) throw new PayrollProviderNotConfiguredError('GUSTO_CLIENT_ID is not set');
    const q = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri, response_type: 'code', state });
    return `${this.baseUrl}/oauth/authorize?${q.toString()}`;
  }

  /** Exchange an authorization code for a company token pair (server-only). */
  async exchangeCode(code: string, redirectUri: string): Promise<GustoTokens> {
    return this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  }

  private async refreshTokens(): Promise<void> {
    if (!this.tokens) throw new PayrollProviderNotConfiguredError('Gusto company tokens missing');
    if (!this.persistTokens) {
      // Refreshing revokes the prior refresh token — refusing beats stranding the tenant.
      throw new PayrollProviderNotConfiguredError('Gusto token refresh requires a persistTokens callback');
    }
    const next = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken });
    await this.persistTokens(next);
    this.tokens = next;
  }

  private async tokenRequest(body: Record<string, string>): Promise<GustoTokens> {
    if (!this.clientId || !this.clientSecret) {
      throw new PayrollProviderNotConfiguredError('GUSTO_CLIENT_ID / GUSTO_CLIENT_SECRET are not set');
    }
    const res = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, ...body }),
    });
    if (!res.ok) throw new GustoHttpError(res.status, 'POST', '/oauth/token');
    const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!json.access_token || !json.refresh_token) throw new Error('Gusto token response missing tokens');
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      // Refresh a minute early (Gusto guidance: expires_in - 60).
      expiresAt: this.now() + Math.max(0, (json.expires_in ?? 7200) - 60) * 1000,
    };
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────

  /** Authenticated JSON request. Refreshes once on expiry or 401. Never logs tokens. */
  private async request<T>(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body?: unknown,
    opts: { expectJson?: boolean } = {},
  ): Promise<T> {
    this.ensureConfigured();
    if (this.tokens && this.tokens.expiresAt <= this.now()) await this.refreshTokens();

    const send = () =>
      this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.tokens!.accessToken}`,
          'X-Gusto-API-Version': GUSTO_API_VERSION,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    let res = await send();
    if (res.status === 401) {
      await this.refreshTokens();
      res = await send();
    }
    if (!res.ok) throw new GustoHttpError(res.status, method, path.split('?')[0]);
    if (opts.expectJson === false || res.status === 202 || res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private sleep(ms: number): Promise<void> {
    return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
  }

  private companyPath(suffix: string): string {
    return `/v1/companies/${encodeURIComponent(this.companyUuid!)}${suffix}`;
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  async status(): Promise<ProviderConnectionStatus> {
    const base = { provider: 'gusto' as const, environment: this.environment };
    if (!this.clientId || !this.clientSecret) {
      return { ...base, state: 'NOT_CONFIGURED', detail: 'GUSTO_CLIENT_ID / GUSTO_CLIENT_SECRET not set' };
    }
    if (!this.companyUuid || !this.tokens) {
      return { ...base, state: 'NOT_CONFIGURED', detail: 'No Gusto company connected for this tenant' };
    }
    try {
      await this.request<unknown>('GET', this.companyPath(''));
      return { ...base, state: 'CONNECTED', detail: null };
    } catch (e) {
      if (e instanceof GustoHttpError && (e.status === 401 || e.status === 403)) {
        return { ...base, state: 'NEEDS_REAUTH', detail: 'Gusto rejected the company token — reconnect' };
      }
      if (e instanceof PayrollProviderNotConfiguredError) {
        return { ...base, state: 'NEEDS_REAUTH', detail: e.message };
      }
      return { ...base, state: 'ERROR', detail: 'Gusto API unreachable' };
    }
  }

  // ── Run payroll ─────────────────────────────────────────────────────────────

  /** Find the pre-generated unprocessed regular payroll whose pay period matches. */
  private async findUnprocessedPayroll(periodStart: string, periodEnd: string): Promise<string> {
    const q = new URLSearchParams({
      processing_statuses: 'unprocessed',
      payroll_types: 'regular,off_cycle',
      start_date: periodStart,
      end_date: periodEnd,
    });
    const list = await this.request<GustoPayrollSummary[]>('GET', this.companyPath(`/payrolls?${q.toString()}`));
    const match =
      (list ?? []).find((p) => p.pay_period?.start_date === periodStart && p.pay_period?.end_date === periodEnd) ??
      (list ?? [])[0];
    const id = match?.payroll_uuid ?? match?.uuid;
    if (!id) throw new Error(`No unprocessed Gusto payroll for ${periodStart}..${periodEnd}`);
    return id;
  }

  private async prepare(payrollUuid: string): Promise<GustoPayrollDetail> {
    return this.request<GustoPayrollDetail>('PUT', this.companyPath(`/payrolls/${encodeURIComponent(payrollUuid)}/prepare`));
  }

  /** Merge Books earnings into a prepared compensation (fixed comps added, hours set). */
  private static mergeCompensation(
    prepared: GustoEmployeeCompensation,
    input: { hours?: number; earnings: PayrollEarning[] },
  ): GustoEmployeeCompensation {
    const fixed = new Map<string, number>();
    for (const f of prepared.fixed_compensations ?? []) {
      if (f.name) fixed.set(f.name, decimalToCents(f.amount ?? '0'));
    }
    for (const e of input.earnings) {
      const name = gustoFixedCompName(e.type);
      if (name) fixed.set(name, (fixed.get(name) ?? 0) + e.amountCents);
    }
    const hourly = (prepared.hourly_compensations ?? []).map((h) =>
      h.name === 'Regular Hours' && typeof input.hours === 'number'
        ? { name: h.name, hours: input.hours.toFixed(3), job_uuid: h.job_uuid }
        : { name: h.name, hours: h.hours, job_uuid: h.job_uuid },
    );
    return {
      employee_uuid: prepared.employee_uuid,
      version: prepared.version,
      excluded: prepared.excluded ?? false,
      payment_method: prepared.payment_method,
      fixed_compensations: [...fixed.entries()].map(([name, cents]) => ({ name, amount: centsToDecimal(cents) })),
      hourly_compensations: hourly,
    };
  }

  /** Poll the payroll until Gusto's async calculation finishes. */
  private async waitForCalculation(payrollUuid: string): Promise<GustoPayrollDetail> {
    const path = this.companyPath(`/payrolls/${encodeURIComponent(payrollUuid)}?include=taxes,benefits,deductions`);
    for (let i = 0; i < this.maxPolls; i++) {
      const p = await this.request<GustoPayrollDetail>('GET', path);
      if (p.calculated_at) return p;
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error('Gusto payroll calculation did not complete in time — retry preview');
  }

  /**
   * Preview = prepare → update compensations → calculate (async) → read back.
   * `employees[].employeeId` MUST be the Gusto employee_uuid (the run layer maps
   * Books employees via payroll.employee_comp.provider_employee_id).
   */
  async previewRun(input: {
    periodStart: string;
    periodEnd: string;
    payDate: string;
    employees: EmployeePayInput[];
  }): Promise<PayrollRunPreview> {
    this.ensureConfigured();
    const payrollUuid = await this.findUnprocessedPayroll(input.periodStart, input.periodEnd);
    const prepared = await this.prepare(payrollUuid);

    const byEmp = new Map(input.employees.map((e) => [e.employeeId, e]));
    const updates = (prepared.employee_compensations ?? [])
      .filter((c) => c.employee_uuid && byEmp.has(c.employee_uuid))
      .map((c) => GustoPayrollProvider.mergeCompensation(c, byEmp.get(c.employee_uuid!)!));

    if (updates.length > 0) {
      await this.request<unknown>('PUT', this.companyPath(`/payrolls/${encodeURIComponent(payrollUuid)}`), {
        employee_compensations: updates,
      });
    }
    await this.request<unknown>('PUT', this.companyPath(`/payrolls/${encodeURIComponent(payrollUuid)}/calculate`), undefined, {
      expectJson: false,
    });
    const calculated = await this.waitForCalculation(payrollUuid);
    return mapGustoPayrollToPreview(calculated, payrollUuid, byEmp);
  }

  /** Submit moves the money (202, async). Only called by releaseRun after SoD approval. */
  async submitRun(input: SubmitRunInput): Promise<{ providerRunId: string; status: 'PROCESSING' | 'PAID' }> {
    this.ensureConfigured();
    const providerRunId =
      input.providerRunId ?? input.preview.employees.find((e) => e.providerRef?.startsWith('gusto_payroll:'))?.providerRef?.slice('gusto_payroll:'.length);
    if (!providerRunId) throw new Error('submitRun requires the Gusto payroll_uuid from preview');
    await this.request<unknown>('PUT', this.companyPath(`/payrolls/${encodeURIComponent(providerRunId)}/submit`), undefined, {
      expectJson: false,
    });
    return { providerRunId, status: 'PROCESSING' };
  }

  async getRunStatus(providerRunId: string): Promise<{ status: 'PROCESSING' | 'PAID' | 'FAILED'; paidAt?: string }> {
    this.ensureConfigured();
    const p = await this.request<GustoPayrollDetail & { cancelled?: boolean }>(
      'GET',
      this.companyPath(`/payrolls/${encodeURIComponent(providerRunId)}`),
    );
    // TODO(gusto-sandbox): prefer the payroll webhook / receipt for settlement.
    if (p.cancelled) return { status: 'FAILED' };
    if (p.processed && p.check_date && Date.parse(`${p.check_date}T23:59:59Z`) <= this.now()) {
      return { status: 'PAID', paidAt: `${p.check_date}T00:00:00.000Z` };
    }
    return { status: 'PROCESSING' };
  }

  // ── Roster / schedules ──────────────────────────────────────────────────────

  async listEmployees(): Promise<ProviderEmployee[]> {
    this.ensureConfigured();
    type GustoEmp = {
      uuid?: string;
      first_name?: string;
      last_name?: string;
      preferred_first_name?: string | null;
      terminated?: boolean;
      onboarded?: boolean;
      department?: string | null;
      jobs?: Array<{ compensations?: Array<{ payment_unit?: string }> }>;
    };
    const rows = await this.request<GustoEmp[]>('GET', this.companyPath('/employees'));
    return (rows ?? []).map((e) => {
      const unit = e.jobs?.[0]?.compensations?.[0]?.payment_unit;
      return {
        providerEmployeeId: e.uuid ?? '',
        displayName: [e.preferred_first_name || e.first_name, e.last_name].filter(Boolean).join(' ') || (e.uuid ?? ''),
        status: e.terminated ? 'TERMINATED' : e.onboarded === false ? 'ONBOARDING' : 'ACTIVE',
        isContractor: false, // contractors are a separate Gusto resource
        departmentName: e.department ?? null,
        payBasis: unit === 'Hour' ? 'HOURLY' : unit ? 'SALARY' : null,
      };
    });
  }

  async listPaySchedules(): Promise<ProviderPaySchedule[]> {
    this.ensureConfigured();
    type GustoSchedule = { uuid?: string; frequency?: string; custom_name?: string | null; name?: string | null; anchor_pay_date?: string | null };
    const rows = await this.request<GustoSchedule[]>('GET', this.companyPath('/pay_schedules'));
    return (rows ?? []).map((s) => ({
      providerScheduleId: s.uuid ?? '',
      name: s.custom_name ?? s.name ?? null,
      frequency: normalizeGustoFrequency(s.frequency),
      anchorPayDate: s.anchor_pay_date ?? null,
    }));
  }

  // ── Documents ───────────────────────────────────────────────────────────────

  async getDocumentLinks(input: {
    providerEmployeeId: string;
    providerRunId?: string;
    year?: number;
  }): Promise<ProviderDocumentLink[]> {
    this.ensureConfigured();
    const emp = encodeURIComponent(input.providerEmployeeId);
    const out: ProviderDocumentLink[] = [];
    if (input.providerRunId) {
      out.push({
        kind: 'PAYSTUB',
        title: 'Pay stub',
        providerEmployeeId: input.providerEmployeeId,
        providerRunId: input.providerRunId,
        year: null,
        retrieval: 'API_PDF',
        apiPath: `/v1/payrolls/${encodeURIComponent(input.providerRunId)}/employees/${emp}/pay_stub`,
        url: null,
      });
    }
    type GustoForm = { uuid?: string; name?: string; title?: string; year?: number | null };
    const forms = await this.request<GustoForm[]>('GET', `/v1/employees/${emp}/forms`);
    for (const f of forms ?? []) {
      const key = `${f.name ?? ''} ${f.title ?? ''}`.toLowerCase();
      const kind = /w-?2-?c/.test(key) ? 'W2C' : /w-?2/.test(key) ? 'W2' : null;
      if (!kind || !f.uuid) continue;
      if (input.year && f.year && f.year !== input.year) continue;
      out.push({
        kind,
        title: f.title ?? kind,
        providerEmployeeId: input.providerEmployeeId,
        providerRunId: null,
        year: f.year ?? null,
        retrieval: 'API_PDF',
        apiPath: `/v1/forms/${encodeURIComponent(f.uuid)}/pdf`,
        url: null,
      });
    }
    return out;
  }

  // ── Journal (GL report) ─────────────────────────────────────────────────────

  async exportJournal(providerRunId: string): Promise<PayrollJournalExport> {
    this.ensureConfigured();
    const req = await this.request<{ request_uuid?: string }>(
      'POST',
      `/v1/payrolls/${encodeURIComponent(providerRunId)}/reports/general_ledger`,
      { aggregation: 'default' },
    );
    if (!req?.request_uuid) throw new Error('Gusto GL report request returned no request_uuid');

    // TODO(gusto-sandbox): confirm report status/url field names on GET /v1/reports/{uuid}.
    let reportUrl: string | null = null;
    for (let i = 0; i < this.maxPolls && !reportUrl; i++) {
      const r = await this.request<{ status?: string; report_urls?: string[]; url?: string }>(
        'GET',
        `/v1/reports/${encodeURIComponent(req.request_uuid)}`,
      );
      reportUrl = r.report_urls?.[0] ?? r.url ?? null;
      if (!reportUrl) await this.sleep(this.pollIntervalMs);
    }
    if (!reportUrl) throw new Error('Gusto GL report not ready — retry');

    // The report URL is pre-signed; do not send the bearer token to a foreign host.
    const res = await this.fetchImpl(reportUrl, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new GustoHttpError(res.status, 'GET', '/reports/<download>');
    const report = (await res.json()) as GustoGlReport;
    return parseGustoGeneralLedger(providerRunId, report);
  }

  // ── Earnings (commissions / bonuses) ────────────────────────────────────────

  /**
   * Push validated earnings into the unprocessed payroll as fixed compensations
   * (Commission / Bonus / Reimbursement). Lines without a provider employee id
   * are rejected — map the employee first.
   */
  async importEarnings(input: ImportEarningsInput): Promise<ImportEarningsResult> {
    this.ensureConfigured();
    const { valid, rejected } = validateEarningsLines(input.lines);
    const indexOf = new Map(input.lines.map((l, i) => [l.sourceRef, i]));
    const reject = (l: { sourceRef: string }, reason: string) =>
      rejected.push({ index: indexOf.get(l.sourceRef) ?? -1, sourceRef: l.sourceRef, reason });

    const mapped = valid.filter((l) => {
      if (l.providerEmployeeId) return true;
      reject(l, 'employee not mapped to a Gusto employee');
      return false;
    });
    if (mapped.length === 0) {
      return { mode: 'API', acceptedCount: 0, acceptedCents: 0, rejected, providerRunId: input.providerRunId ?? null, file: null };
    }

    const payrollUuid = input.providerRunId ?? (await this.findUnprocessedPayroll(input.periodStart, input.periodEnd));
    const prepared = await this.prepare(payrollUuid);
    const present = new Set((prepared.employee_compensations ?? []).map((c) => c.employee_uuid));
    const accepted = mapped.filter((l) => {
      if (present.has(l.providerEmployeeId!)) return true;
      reject(l, 'employee is not on this Gusto payroll');
      return false;
    });
    const byEmp = new Map<string, PayrollEarning[]>();
    for (const l of accepted) {
      const list = byEmp.get(l.providerEmployeeId!) ?? [];
      list.push({ type: EXTERNAL_TO_GUSTO[l.earningType], amountCents: l.amountCents });
      byEmp.set(l.providerEmployeeId!, list);
    }
    const updates = (prepared.employee_compensations ?? [])
      .filter((c) => c.employee_uuid && byEmp.has(c.employee_uuid))
      .map((c) => GustoPayrollProvider.mergeCompensation(c, { earnings: byEmp.get(c.employee_uuid!)! }));
    if (updates.length > 0) {
      await this.request<unknown>('PUT', this.companyPath(`/payrolls/${encodeURIComponent(payrollUuid)}`), {
        employee_compensations: updates,
      });
    }
    return {
      mode: 'API',
      acceptedCount: accepted.length,
      acceptedCents: accepted.reduce((s, l) => s + l.amountCents, 0),
      rejected,
      providerRunId: payrollUuid,
      file: null,
    };
  }

  // ── PTO ─────────────────────────────────────────────────────────────────────

  async getPtoBalances(): Promise<PtoBalance[]> {
    this.ensureConfigured();
    // TODO(gusto-sandbox): confirm policy → employees[].balance shape.
    type Policy = { name?: string; employees?: Array<{ uuid?: string; balance?: string | number }> };
    const policies = await this.request<Policy[]>('GET', this.companyPath('/time_off_policies'));
    const out: PtoBalance[] = [];
    for (const p of policies ?? []) {
      for (const e of p.employees ?? []) {
        if (!e.uuid) continue;
        const hours = typeof e.balance === 'number' ? e.balance : Number(e.balance ?? 0);
        out.push({ providerEmployeeId: e.uuid, policyName: p.name ?? 'Time off', balanceHours: Number.isFinite(hours) ? hours : 0 });
      }
    }
    return out;
  }
}
