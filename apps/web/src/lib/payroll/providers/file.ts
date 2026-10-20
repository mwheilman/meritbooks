/**
 * FilePayrollProvider — the "ANY payroll system works today" adapter.
 *
 * Owner decision: payroll is provider-agnostic. A tenant on ADP, Paychex,
 * Paylocity, QuickBooks Payroll, Gusto (without the API connection), or a
 * spreadsheet runs payroll THERE and uses files to close the loop with Books:
 *
 *   IN  — payroll register (CSV / XLSX) → the deterministic register importer
 *         (register-csv.ts: parseDelimited / guessMapping / aggregateRows /
 *         aggregatedToNormalized) → the SAME NormalizedRegister the AI path makes
 *         → buildProposedPayrollJE → human confirms → balanced GL post (existing
 *         /api/payroll/import-register/csv/* routes). Nothing new is invented here;
 *         this adapter just exposes that path through the provider seam.
 *   OUT — earnings (commissions, bonuses, spiffs) → a provider-neutral earnings CSV
 *         (earnings.ts) the tenant uploads to their payroll system's
 *         "import earnings / one-time pay" screen. Column names and earning codes
 *         are overridable to match each system's template.
 *
 * Books never runs gross-to-net in this mode, so previewRun / submitRun /
 * getRunStatus throw PayrollCapabilityUnsupportedError (never fake numbers).
 */

import type {
  EmployeePayInput,
  PayrollRunPreview,
  SubmitRunInput,
} from '../engine/types';
import {
  PayrollCapabilityUnsupportedError,
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
import { renderEarningsCsv, validateEarningsLines, type EarningsCsvOptions } from './earnings';
import {
  aggregateRows,
  aggregatedToNormalized,
  guessMapping,
  parseDelimited,
  type AggregatedRegister,
  type ColumnMapping,
} from '../register-csv';
import type { NormalizedRegister } from '../register-parse';

export const FILE_CAPABILITIES: PayrollProviderCapabilities = Object.freeze({
  runPayroll: false,
  employeeSync: false,
  paySchedules: false,
  documents: false,
  journalExport: false,
  earningsImport: true,
  ptoBalances: false,
  registerImport: true,
});

export interface FileProviderConfig {
  /** Free-text name of the outside system (e.g. "ADP Workforce Now") for UI copy + filenames. */
  systemName?: string | null;
  /** Tenant's saved earnings-file template (column names, earning codes). */
  earningsCsv?: EarningsCsvOptions;
  /** Employee self-service portal URL of the outside system (pay stubs / W-2s live there). */
  employeePortalUrl?: string | null;
}

/** Result of importing a register file through the provider seam. */
export interface RegisterFileImport {
  mapping: ColumnMapping[];
  aggregated: AggregatedRegister;
  normalized: NormalizedRegister;
}

export class FilePayrollProvider implements PayrollProvider {
  readonly name = 'file';
  readonly id = 'file' as const;
  readonly displayName: string;
  readonly capabilities = FILE_CAPABILITIES;
  private readonly config: FileProviderConfig;

  constructor(config: FileProviderConfig = {}) {
    this.config = config;
    this.displayName = config.systemName?.trim() ? `${config.systemName.trim()} (file import)` : 'Any payroll system (file import)';
  }

  isConfigured(): boolean {
    return true; // nothing to configure — files work with every payroll system
  }

  async status(): Promise<ProviderConnectionStatus> {
    return {
      provider: 'file',
      state: 'CONNECTED',
      detail: 'Run payroll in your payroll system, import the register here, export earnings as CSV.',
      environment: null,
    };
  }

  private unsupported(capability: keyof PayrollProviderCapabilities): never {
    throw new PayrollCapabilityUnsupportedError(
      'file',
      capability,
      'payroll runs in your payroll system — import its register (CSV/XLSX) to post the GL',
    );
  }

  async previewRun(_input: {
    periodStart: string;
    periodEnd: string;
    payDate: string;
    employees: EmployeePayInput[];
  }): Promise<PayrollRunPreview> {
    return this.unsupported('runPayroll');
  }

  async submitRun(_input: SubmitRunInput): Promise<{ providerRunId: string; status: 'PROCESSING' | 'PAID' }> {
    return this.unsupported('runPayroll');
  }

  async getRunStatus(_providerRunId: string): Promise<{ status: 'PROCESSING' | 'PAID' | 'FAILED'; paidAt?: string }> {
    return this.unsupported('runPayroll');
  }

  async listEmployees(): Promise<ProviderEmployee[]> {
    return this.unsupported('employeeSync');
  }

  async listPaySchedules(): Promise<ProviderPaySchedule[]> {
    return this.unsupported('paySchedules');
  }

  /** Pay stubs / W-2s live in the outside system's portal — link there when known. */
  async getDocumentLinks(input: { providerEmployeeId: string; year?: number }): Promise<ProviderDocumentLink[]> {
    if (!this.config.employeePortalUrl) return [];
    return [
      {
        kind: 'OTHER',
        title: 'Pay stubs and W-2s (payroll portal)',
        providerEmployeeId: input.providerEmployeeId,
        providerRunId: null,
        year: input.year ?? null,
        retrieval: 'PROVIDER_PORTAL',
        apiPath: null,
        url: this.config.employeePortalUrl,
      },
    ];
  }

  async exportJournal(_providerRunId: string): Promise<PayrollJournalExport> {
    return this.unsupported('journalExport');
  }

  /** Render the earnings CSV (mode FILE). Invalid lines are rejected, never written. */
  async importEarnings(input: ImportEarningsInput): Promise<ImportEarningsResult> {
    const { valid, rejected } = validateEarningsLines(input.lines);
    const stem = (this.config.systemName ?? 'payroll').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const file =
      valid.length > 0
        ? renderEarningsCsv(input, valid, { filenameStem: `${stem || 'payroll'}-earnings`, ...this.config.earningsCsv })
        : null;
    return {
      mode: 'FILE',
      acceptedCount: valid.length,
      acceptedCents: valid.reduce((s, l) => s + l.amountCents, 0),
      rejected,
      providerRunId: null,
      file,
    };
  }

  async getPtoBalances(): Promise<PtoBalance[]> {
    return this.unsupported('ptoBalances');
  }

  /**
   * Import a payroll REGISTER exported from any system (CSV/TSV text; XLSX bytes go
   * through xlsx-read.ts server-side first, then the grid comes here). Reuses the
   * existing deterministic importer — auto-maps columns unless a confirmed mapping
   * is supplied — and returns the normalized totals the JE builder consumes.
   */
  importRegisterText(
    text: string,
    meta: { payDate: string | null; periodStart: string | null; periodEnd: string | null },
    mapping?: ColumnMapping[],
  ): RegisterFileImport {
    const grid = parseDelimited(text);
    const cols = mapping ?? guessMapping(grid.headers);
    const aggregated = aggregateRows(grid.rows, cols);
    return { mapping: cols, aggregated, normalized: aggregatedToNormalized(aggregated, meta) };
  }
}
