/**
 * Provider-agnostic PAYROLL PROVIDER contract (Owner decision: payroll must work
 * with ANY payroll system; Gusto is the likely first API provider).
 *
 * `PayrollProvider` is the full seam every payroll system plugs in behind. It
 * EXTENDS the narrower `PayrollEngine` run contract (`../engine/types`) that the
 * run workflow (`lib/payroll/run.ts`) already builds against, so the run path is
 * unchanged and every provider is also a valid engine.
 *
 * Three kinds of adapter implement it:
 *   - API providers (Gusto, Check): the provider runs gross-to-net, moves money,
 *     files taxes; Books posts the GL and reconciles.
 *   - The FILE adapter (`file`): ANY payroll system (ADP, Paychex, Paylocity, QBO
 *     Payroll, a spreadsheet). The tenant runs payroll there, imports the payroll
 *     register (CSV/XLSX) into Books, and exports earnings (commissions, bonuses)
 *     as a CSV to load into their system. No API needed — works today.
 *   - The MOCK adapter: deterministic dev / no-provider fallback.
 *
 * Not every provider supports every operation. `capabilities` advertises what is
 * implemented; calling an unsupported operation throws
 * `PayrollCapabilityUnsupportedError` (never a silent no-op, never fake numbers).
 *
 * HARD INVARIANT (canon §2 / payroll FPB §2): no PII crosses this boundary — no
 * SSN, bank/routing numbers, withholding elections, home addresses or dates of
 * birth. Only opaque provider handles, display names, statuses and integer-cent
 * amounts. Adapters must map provider payloads through allow-listed fields only.
 */

import type { PayrollEngine } from '../engine/types';

export type { PayrollEngine } from '../engine/types';

/** Stable adapter ids. `core.provider_connections.provider` stores these strings. */
export type PayrollProviderId = 'mock' | 'check' | 'gusto' | 'file';

export const PAYROLL_PROVIDER_IDS: readonly PayrollProviderId[] = ['mock', 'check', 'gusto', 'file'];

export function isPayrollProviderId(v: unknown): v is PayrollProviderId {
  return typeof v === 'string' && (PAYROLL_PROVIDER_IDS as readonly string[]).includes(v);
}

/** What an adapter actually implements. Drives UI affordances + graceful errors. */
export interface PayrollProviderCapabilities {
  /** previewRun / submitRun / getRunStatus move a run through the provider. */
  runPayroll: boolean;
  /** listEmployees returns the provider roster. */
  employeeSync: boolean;
  /** listPaySchedules returns provider pay schedules. */
  paySchedules: boolean;
  /** getDocumentLinks returns pay stub / W-2 retrieval handles. */
  documents: boolean;
  /** exportJournal returns the provider's journal / GL report for a run. */
  journalExport: boolean;
  /** importEarnings pushes commissions/bonuses (API) or renders an earnings file. */
  earningsImport: boolean;
  /** getPtoBalances returns time-off balances. */
  ptoBalances: boolean;
  /** The tenant imports a payroll register file (CSV/XLSX) into Books. */
  registerImport: boolean;
}

export type ProviderConnectionState = 'CONNECTED' | 'NOT_CONFIGURED' | 'NEEDS_REAUTH' | 'ERROR';

export interface ProviderConnectionStatus {
  provider: PayrollProviderId;
  state: ProviderConnectionState;
  /** Human-readable detail. Never contains a secret. */
  detail: string | null;
  /** 'test' | 'live' when known. */
  environment: 'test' | 'live' | null;
}

/** Roster entry. Allow-listed, non-PII fields only. */
export interface ProviderEmployee {
  providerEmployeeId: string;
  displayName: string;
  status: 'ACTIVE' | 'ONBOARDING' | 'TERMINATED';
  isContractor: boolean;
  departmentName: string | null;
  payBasis: 'HOURLY' | 'SALARY' | null;
}

export type PayFrequency = 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY' | 'OTHER';

export interface ProviderPaySchedule {
  providerScheduleId: string;
  name: string | null;
  frequency: PayFrequency;
  /** ISO date of a known pay date the schedule is anchored to, when provided. */
  anchorPayDate: string | null;
}

export type ProviderDocumentKind = 'PAYSTUB' | 'W2' | 'W2C' | 'FORM_1099' | 'OTHER';

/**
 * A handle to retrieve a provider-generated document. Books never stores the
 * document (it can contain PII); it proxies or links:
 *   - API_PDF: server fetches `apiPath` with the tenant's token and streams it.
 *   - URL: a provider-hosted URL (may be short-lived).
 *   - PROVIDER_PORTAL: the employee self-service portal (file adapter / no API).
 */
export interface ProviderDocumentLink {
  kind: ProviderDocumentKind;
  title: string;
  providerEmployeeId: string;
  providerRunId: string | null;
  year: number | null;
  retrieval: 'API_PDF' | 'URL' | 'PROVIDER_PORTAL';
  apiPath: string | null;
  url: string | null;
}

/** One line of a provider journal / GL report. Integer cents. */
export interface PayrollJournalLine {
  /** Provider's account-type key (e.g. Gusto 'RegularWages', 'EmployerTax', 'DebitNetPay'). */
  accountType: string;
  description: string;
  debitCents: number;
  creditCents: number;
  /** Provider job / department label, when the provider splits by it. */
  job: string | null;
}

export interface PayrollJournalExport {
  providerRunId: string;
  checkDate: string | null;
  lines: PayrollJournalLine[];
  totalDebitCents: number;
  totalCreditCents: number;
  balanced: boolean;
}

/** Earning categories Books pushes to payroll (commissions engine, bonuses). */
export type ExternalEarningType = 'COMMISSION' | 'BONUS' | 'SPIFF' | 'REIMBURSEMENT' | 'OTHER';

/** One earnings line Books asks the payroll system to pay. Integer cents. */
export interface EarningsLine {
  /** Books employee id (core.employees.id). */
  employeeId: string;
  /** Provider handle when mapped (payroll.employee_comp.provider_employee_id). */
  providerEmployeeId: string | null;
  /** Display name for the earnings file (the file adapter only). */
  employeeName: string;
  earningType: ExternalEarningType;
  amountCents: number;
  /** Free text that appears on the stub / import (e.g. "Oct commissions, 14 jobs"). */
  memo: string | null;
  /** Books source correlation (e.g. commission statement id) for audit + idempotency. */
  sourceRef: string;
}

export interface ImportEarningsInput {
  payDate: string;
  periodStart: string;
  periodEnd: string;
  /** Provider payroll to attach to; when omitted the adapter finds the unprocessed payroll for payDate. */
  providerRunId?: string;
  lines: EarningsLine[];
}

export interface EarningsLineRejection {
  index: number;
  sourceRef: string;
  reason: string;
}

/** A rendered file for the tenant to load into their payroll system. */
export interface RenderedFile {
  filename: string;
  contentType: string;
  content: string;
}

export interface ImportEarningsResult {
  /** API = pushed into the provider; FILE = rendered for manual upload. */
  mode: 'API' | 'FILE';
  acceptedCount: number;
  acceptedCents: number;
  rejected: EarningsLineRejection[];
  providerRunId: string | null;
  file: RenderedFile | null;
}

export interface PtoBalance {
  providerEmployeeId: string;
  policyName: string;
  /** Hours, as a decimal number (hours are not money). */
  balanceHours: number;
}

/**
 * The full provider seam. Extends the run-only `PayrollEngine` so run.ts is
 * unchanged. Every method either does real work or throws
 * `PayrollCapabilityUnsupportedError` / `PayrollProviderNotConfiguredError`.
 */
export interface PayrollProvider extends PayrollEngine {
  readonly id: PayrollProviderId;
  readonly displayName: string;
  readonly capabilities: PayrollProviderCapabilities;
  /** True when credentials/config are present (cheap, no network). */
  isConfigured(): boolean;
  /** Connection health (may call the provider). Never throws for "not configured". */
  status(): Promise<ProviderConnectionStatus>;
  listEmployees(): Promise<ProviderEmployee[]>;
  listPaySchedules(): Promise<ProviderPaySchedule[]>;
  getDocumentLinks(input: {
    providerEmployeeId: string;
    providerRunId?: string;
    year?: number;
  }): Promise<ProviderDocumentLink[]>;
  exportJournal(providerRunId: string): Promise<PayrollJournalExport>;
  importEarnings(input: ImportEarningsInput): Promise<ImportEarningsResult>;
  getPtoBalances(): Promise<PtoBalance[]>;
}

/** Thrown when an adapter does not implement an operation (see `capabilities`). */
export class PayrollCapabilityUnsupportedError extends Error {
  readonly provider: PayrollProviderId;
  readonly capability: keyof PayrollProviderCapabilities;
  constructor(provider: PayrollProviderId, capability: keyof PayrollProviderCapabilities, hint?: string) {
    super(`Payroll provider "${provider}" does not support ${capability}${hint ? ` — ${hint}` : ''}`);
    this.name = 'PayrollCapabilityUnsupportedError';
    this.provider = provider;
    this.capability = capability;
  }
}

/** Shape of a balanced-journal check, shared by adapters that build journals. */
export function summarizeJournal(
  providerRunId: string,
  checkDate: string | null,
  lines: PayrollJournalLine[],
): PayrollJournalExport {
  const totalDebitCents = lines.reduce((s, l) => s + l.debitCents, 0);
  const totalCreditCents = lines.reduce((s, l) => s + l.creditCents, 0);
  return {
    providerRunId,
    checkDate,
    lines,
    totalDebitCents,
    totalCreditCents,
    balanced: totalDebitCents === totalCreditCents && totalDebitCents > 0,
  };
}

/**
 * Parse a provider decimal-dollar string ("1234.56", "-12.5", "1,200.00") or
 * number to integer cents WITHOUT float multiplication. Unparseable → 0.
 */
export function decimalToCents(raw: unknown): number {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return 0;
    return decimalToCents(raw.toFixed(2));
  }
  if (typeof raw !== 'string') return 0;
  const s = raw.trim().replace(/[$,\s]/g, '');
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return 0;
  const whole = Number(m[2] || '0');
  const fracRaw = (m[3] ?? '').padEnd(3, '0');
  // Round half-up on the third decimal (providers send 2dp; this is defensive).
  let frac = Number(fracRaw.slice(0, 2));
  if (Number(fracRaw[2]) >= 5) frac += 1;
  const cents = whole * 100 + frac;
  return m[1] ? -cents : cents;
}

/** Integer cents → "1234.56" (provider request bodies). No float math. */
export function centsToDecimal(cents: number): string {
  const n = Math.trunc(Number(cents) || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
