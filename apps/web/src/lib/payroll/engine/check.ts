/**
 * CheckPayrollEngine — adapter for Check (https://docs.checkhq.com), a payroll
 * INFRASTRUCTURE API. Check is the regulated party: it computes gross-to-net,
 * withholds/remits taxes, files returns, and moves the money. This adapter only
 * translates the provider-agnostic `PayrollEngine` contract to Check's API shape
 * and reads amounts + opaque refs back.
 *
 * SECURITY / PII (canon §2, payroll FPB §2 + §11):
 *  - The Check API key is a per-tenant secret resolved from the Core Vault via
 *    `core.provider_connections.secret_ref` (migration 041). It is passed to this
 *    class server-side ONLY and is NEVER logged, serialized, or returned.
 *  - No SSN / bank / routing / withholding election ever crosses this boundary.
 *    Check custodies employee PII; we hold only opaque handles + amounts.
 *  - Construct only on the server (service-role path). Never instantiate in the
 *    browser or embed the key in client code.
 *
 * If Check credentials/config are absent, every method fails GRACEFULLY with a
 * `PayrollProviderNotConfiguredError` ("payroll provider not configured") rather
 * than crashing — so an unconfigured tenant degrades cleanly (FPB acceptance #12).
 *
 * The HTTP calls below are scaffolded against Check's documented object model
 * (company / employee / payroll). The exact endpoint paths/params are marked with
 * TODO where Check's precise shape must be confirmed against a live sandbox; the
 * class + method signatures are real and typed and MUST NOT change.
 */

import {
  PayrollProviderNotConfiguredError,
  type EmployeePayInput,
  type EmployeePayResult,
  type PayrollEngine,
  type PayrollRunPreview,
  type PayrollRunTotals,
  type SubmitRunInput,
} from './types';

export interface CheckEngineConfig {
  /** Check company handle (opaque provider id) from core.provider_connections.account_handle. */
  accountHandle: string | null;
  /** Check API key resolved from the Vault secret_ref. Server-only. Never logged. */
  apiKey: string | null;
  /** 'test' | 'live' — from the connection row; selects the sandbox vs live base URL. */
  environment: 'test' | 'live';
  /** Override base URL (else derived from environment / CHECK_API_BASE_URL env). */
  baseUrl?: string;
}

/** Default Check API base. Override per-env via CHECK_API_BASE_URL. */
const DEFAULT_CHECK_BASE_URL = 'https://api.checkhq.com';

export class CheckPayrollEngine implements PayrollEngine {
  readonly name = 'check';

  private readonly accountHandle: string | null;
  private readonly apiKey: string | null;
  private readonly baseUrl: string;

  constructor(config: CheckEngineConfig) {
    this.accountHandle = config.accountHandle;
    this.apiKey = config.apiKey;
    this.baseUrl =
      config.baseUrl ?? process.env.CHECK_API_BASE_URL ?? DEFAULT_CHECK_BASE_URL;
  }

  /** True only when we have a company handle, an API key, and a base URL. */
  isConfigured(): boolean {
    return Boolean(this.accountHandle && this.apiKey && this.baseUrl);
  }

  private ensureConfigured(): { accountHandle: string; apiKey: string; baseUrl: string } {
    if (!this.isConfigured()) {
      throw new PayrollProviderNotConfiguredError(
        'payroll provider not configured: Check company handle / API key / base URL missing',
      );
    }
    // Non-null asserted by isConfigured().
    return { accountHandle: this.accountHandle!, apiKey: this.apiKey!, baseUrl: this.baseUrl };
  }

  /**
   * Thin typed HTTP wrapper around Check's REST API. Uses the fetch client (no SDK)
   * to keep the boundary provider-shape-only. NEVER logs the Authorization header
   * or the API key.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { apiKey, baseUrl } = this.ensureConfigured();
    const url = `${baseUrl.replace(/\/$/, '')}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        // Bearer auth per Check docs. Secret is never logged.
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!res.ok) {
      // Deliberately do not include headers/body that could echo the secret.
      const detail = await res.text().catch(() => '');
      throw new Error(`Check API ${method} ${path} failed: ${res.status} ${res.statusText} ${detail}`.trim());
    }
    return (await res.json()) as T;
  }

  async previewRun(input: {
    periodStart: string;
    periodEnd: string;
    payDate: string;
    employees: EmployeePayInput[];
  }): Promise<PayrollRunPreview> {
    const { accountHandle } = this.ensureConfigured();

    // TODO(check-sandbox): confirm exact Check endpoints/params. Documented model:
    //   1. Create a payroll for the company + pay period:
    //        POST /companies/{company}/payrolls
    //        { period_start, period_end, payday, items: [{ employee, earnings: [...] }] }
    //   2. Check computes gross-to-net; read it back (preview) via the payroll object,
    //      which carries per-item gross/net/taxes and totals.
    const created = await this.request<CheckPayrollObject>(
      'POST',
      `/companies/${encodeURIComponent(accountHandle)}/payrolls`,
      {
        period_start: input.periodStart,
        period_end: input.periodEnd,
        payday: input.payDate,
        // Map provider-agnostic earnings → Check payroll items. Amounts only, no PII.
        items: input.employees.map((emp) => ({
          employee: emp.employeeId,
          hours: emp.hours,
          earnings: emp.earnings.map((e) => ({ type: e.type, amount: e.amountCents })),
        })),
      },
    );

    return mapCheckPayrollToPreview(created);
  }

  async submitRun(
    input: SubmitRunInput,
  ): Promise<{ providerRunId: string; status: 'PROCESSING' | 'PAID' }> {
    const runId = input.providerRunId;
    if (!runId) {
      // A Check payroll must already exist (created at previewRun) before it can be approved.
      throw new Error('submitRun requires the providerRunId returned/created at preview time');
    }
    this.ensureConfigured();

    // TODO(check-sandbox): confirm the approve/process endpoint. Documented model:
    //   POST /payrolls/{payroll}/approve  → transitions the payroll to processing.
    const approved = await this.request<CheckPayrollObject>(
      'POST',
      `/payrolls/${encodeURIComponent(runId)}/approve`,
    );

    return {
      providerRunId: approved.id ?? runId,
      status: normalizeCheckStatus(approved.status) === 'PAID' ? 'PAID' : 'PROCESSING',
    };
  }

  async getRunStatus(
    providerRunId: string,
  ): Promise<{ status: 'PROCESSING' | 'PAID' | 'FAILED'; paidAt?: string }> {
    this.ensureConfigured();

    // TODO(check-sandbox): confirm the read endpoint. Documented model:
    //   GET /payrolls/{payroll}
    const payroll = await this.request<CheckPayrollObject>(
      'GET',
      `/payrolls/${encodeURIComponent(providerRunId)}`,
    );

    const status = normalizeCheckStatus(payroll.status);
    return { status, paidAt: status === 'PAID' ? payroll.paid_at ?? undefined : undefined };
  }
}

// ---------------------------------------------------------------------------
// Check API shapes + mappers (amounts only; no PII fields are read here).
// ---------------------------------------------------------------------------

/** Minimal Check payroll object shape we depend on. Extend as the sandbox is wired. */
interface CheckPayrollObject {
  id?: string;
  status?: string; // e.g. 'draft' | 'pending' | 'processing' | 'paid' | 'failed'
  paid_at?: string | null;
  totals?: {
    gross?: number;
    net?: number;
    employee_taxes?: number;
    employer_taxes?: number;
    deductions?: number;
    benefits?: number;
  };
  items?: Array<{
    employee?: string;
    id?: string;
    gross?: number;
    net?: number;
    employee_taxes?: number;
    employer_taxes?: number;
    deductions?: number;
    benefits?: number;
  }>;
}

/** Map Check's computed status string to our tri-state. */
function normalizeCheckStatus(status?: string): 'PROCESSING' | 'PAID' | 'FAILED' {
  switch ((status ?? '').toLowerCase()) {
    case 'paid':
    case 'processed':
    case 'complete':
    case 'completed':
      return 'PAID';
    case 'failed':
    case 'error':
    case 'reversed':
      return 'FAILED';
    default:
      return 'PROCESSING';
  }
}

/** Map a Check payroll object → the provider-agnostic preview. Amounts are already in cents. */
function mapCheckPayrollToPreview(payroll: CheckPayrollObject): PayrollRunPreview {
  const employees: EmployeePayResult[] = (payroll.items ?? []).map((it) => ({
    employeeId: it.employee ?? '',
    grossCents: it.gross ?? 0,
    netCents: it.net ?? 0,
    employeeTaxCents: it.employee_taxes ?? 0,
    employerTaxCents: it.employer_taxes ?? 0,
    deductionsCents: it.deductions ?? 0,
    benefitsCents: it.benefits ?? 0,
    providerRef: it.id,
  }));

  const totals: PayrollRunTotals = payroll.totals
    ? {
        grossCents: payroll.totals.gross ?? 0,
        netCents: payroll.totals.net ?? 0,
        employeeTaxCents: payroll.totals.employee_taxes ?? 0,
        employerTaxCents: payroll.totals.employer_taxes ?? 0,
        deductionsCents: payroll.totals.deductions ?? 0,
        benefitsCents: payroll.totals.benefits ?? 0,
      }
    : employees.reduce<PayrollRunTotals>(
        (acc, e) => ({
          grossCents: acc.grossCents + e.grossCents,
          netCents: acc.netCents + e.netCents,
          employeeTaxCents: acc.employeeTaxCents + e.employeeTaxCents,
          employerTaxCents: acc.employerTaxCents + e.employerTaxCents,
          deductionsCents: acc.deductionsCents + e.deductionsCents,
          benefitsCents: acc.benefitsCents + e.benefitsCents,
        }),
        {
          grossCents: 0,
          netCents: 0,
          employeeTaxCents: 0,
          employerTaxCents: 0,
          deductionsCents: 0,
          benefitsCents: 0,
        },
      );

  return { employees, totals };
}
