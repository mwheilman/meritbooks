/**
 * GATE 12 — provider abstraction layer (Books).
 *
 * One interface per money-movement capability. Concrete adapters
 * (stripe-connect.ts, increase.ts, melio.ts, check.ts, gusto.ts, plaid.ts, …)
 * each implement exactly ONE of these and are selected per-tenant from
 * core.provider_connections at runtime. No provider SDK type, webhook shape, or
 * identifier may leak above this boundary — that is what keeps the recommended
 * providers (§8 of the spec) swappable without touching ledger, reconciliation,
 * approval, audit, or UI.
 *
 * These are contracts only. Adapters are implemented per sub-gate as each
 * provider's sandbox credentials become available; nothing here moves money.
 */

export type Capability = 'AR_COLLECTION' | 'AP_DISBURSEMENT' | 'PAYROLL' | 'BANK_FEED';
export type ProviderEnvironment = 'test' | 'live';
export type ConnectionStatus = 'active' | 'disconnected' | 'error';

/** The capability -> entitlement key in core.organizations.entitlements. */
export const CAPABILITY_ENTITLEMENT: Record<Capability, string> = {
  AR_COLLECTION: 'ar_collection',
  AP_DISBURSEMENT: 'ap_disbursement',
  PAYROLL: 'payroll',
  BANK_FEED: 'bank_feed',
};

/** A registered connection as seen by the application (never includes the secret). */
export interface ProviderConnection {
  id: string;
  orgId: string;
  capability: Capability;
  provider: string;
  environment: ProviderEnvironment;
  accountHandle: string | null;
  /** Reference into the Vault — opaque; the secret value is fetched server-side only. */
  secretRef: string | null;
  status: ConnectionStatus;
  connectedBy: string | null;
  statusDetail: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Resolved adapter context: the connection plus the decrypted secret (server-only). */
export interface ProviderContext {
  connection: ProviderConnection;
  secret: string;
}

// ---------------------------------------------------------------------------
// Capability interfaces (implemented by adapters in later sub-gates)
// ---------------------------------------------------------------------------

export interface MoneyResult {
  providerId: string; // provider's id for the created object
  status: string;     // provider status, normalized by the adapter
}

/** Money-in: card / ACH collection on AR invoices. */
export interface ArProcessor {
  readonly provider: string;
  createPaymentLink(input: {
    invoiceId: string;
    amountCents: number;
    currency: string;
    description?: string;
  }): Promise<{ url: string; providerId: string }>;
  refund(input: { providerPaymentId: string; amountCents: number; reason?: string }): Promise<MoneyResult>;
  /** Normalize an already-verified provider webhook payload into a settlement/dispute event. */
  parseEvent(payload: unknown): Promise<
    | { type: 'payment_settled'; providerPaymentId: string; feeCents: number; payoutId: string | null }
    | { type: 'dispute'; providerPaymentId: string; amountCents: number }
    | { type: 'ignored' }
  >;
}

/** Money-out: AP disbursement by ACH / check / (later) wire. */
export interface ApDisburser {
  readonly provider: string;
  createDisbursement(input: {
    rail: 'ACH' | 'CHECK' | 'WIRE';
    amountCents: number;
    vendorPaymentMethodHandle: string;
    memo?: string;
    idempotencyKey: string;
  }): Promise<MoneyResult>;
  cancel(input: { providerTransferId: string }): Promise<MoneyResult>;
  parseEvent(payload: unknown): Promise<
    | { type: 'settled'; providerTransferId: string }
    | { type: 'returned'; providerTransferId: string; returnCode: string }
    | { type: 'ignored' }
  >;
}

/** Payroll-as-a-service: provider calculates, files, and remits; we post the receipt. */
export interface PayrollEngine {
  readonly provider: string;
  prepareRun(input: { providerCompanyHandle: string; periodStart: string; periodEnd: string }): Promise<{ providerRunId: string }>;
  approveRun(input: { providerRunId: string }): Promise<MoneyResult>;
  /** The provider's payroll receipt — the source of truth for the GL posting. */
  getReceipt(input: { providerRunId: string }): Promise<PayrollReceipt>;
  parseEvent(payload: unknown): Promise<
    | { type: 'run_paid'; providerRunId: string }
    | { type: 'filing_update'; form: string; period: string; status: string }
    | { type: 'garnishment_remitted'; providerRunId: string; agency: string }
    | { type: 'ignored' }
  >;
}

export interface PayrollReceipt {
  providerRunId: string;
  cashRequirementCents: number;
  lines: Array<{
    employeeHandle: string;
    grossCents: number;
    netCents: number;
    employeeTaxes: Array<{ agency: string; cents: number }>;
    employerTaxes: Array<{ agency: string; cents: number }>;
    postTaxDeductions: Array<{ kind: string; agency: string | null; cents: number }>;
    benefits: Array<{ kind: string; cents: number }>;
    // Dimensions for cost allocation; resolved to GL accounts by the posting layer.
    departmentId: string | null;
    jobId: string | null;
  }>;
}

/** Bank feed: transaction + balance aggregation (Plaid incumbent). */
export interface BankFeed {
  readonly provider: string;
  syncTransactions(input: { connectionAccountHandle: string; sinceCursor?: string }): Promise<{
    added: Array<{
      providerTxnId: string;
      postedAt: string;
      amountCents: number;
      description: string;
    }>;
    nextCursor: string | null;
  }>;
  getBalanceCents(input: { connectionAccountHandle: string }): Promise<number>;
}
