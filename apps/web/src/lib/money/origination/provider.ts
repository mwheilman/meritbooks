/**
 * Provider-agnostic money-OUT ORIGINATION contract (migration 143).
 *
 * MeritBooks batches, approves, POSTS, and exports AP disbursements today, but has
 * no live rail. This interface is the single seam a real ACH/wire provider plugs in
 * behind. A SANDBOX adapter (deterministic, no network) satisfies it now; a real
 * provider (an ACH API) is a LATER adapter behind THIS interface + credentials — so
 * turning the rail on is a credential swap, never a rewrite.
 *
 * HARD INVARIANT (canon §3, migration 143 header): origination does NOT post to the
 * GL and does NOT itself move money in this build. The disbursement RELEASE already
 * posted DR A/P / CR Cash via recordBillPayment. This lane records only the rail
 * hand-off (submission) + the returned lifecycle (SUBMITTED → SETTLED / RETURNED /
 * FAILED). A RETURN is FLAGGED for a human — never auto-reversed — because a real
 * return needs a reversing GL entry a person must authorize.
 *
 * No PII and no secrets cross this boundary or land in `trace`. Money is bigint
 * cents. DO NOT rename these types — routes, the service, and adapters build on them.
 */

export type OriginationRail = 'ACH' | 'WIRE';

/** Per-payee item lifecycle (mirrors the migration-143 items CHECK constraint). */
export type OriginationItemStatus = 'PENDING' | 'SUBMITTED' | 'SETTLED' | 'FAILED' | 'RETURNED';

/** Batch lifecycle (mirrors the migration-143 batches CHECK constraint). */
export type OriginationBatchStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'SETTLED'
  | 'FAILED'
  | 'RETURNED'
  | 'CANCELED';

/** One payee line handed to the rail. Opaque ids + an amount only — never PII. */
export interface OriginationLine {
  /** our public.payment_origination_items.id */
  itemId: string;
  amountCents: number;
  vendorId: string | null;
}

export interface SubmitBatchInput {
  /** our public.payment_origination_batches.id */
  batchId: string;
  rail: OriginationRail;
  effectiveDate: string | null;
  lines: OriginationLine[];
}

/** Provider verdict for one line (echoed on submit and on status polls). */
export interface ProviderItemResult {
  itemId: string;
  status: OriginationItemStatus;
  /** opaque provider line reference (optional). */
  providerItemRef?: string;
  /** ACH return code (e.g. 'R01') when the line RETURNED. */
  returnCode?: string | null;
}

export interface SubmitBatchResult {
  /** the id the rail returns for the whole batch (opaque). */
  providerBatchRef: string;
  /** SUBMITTED on a clean hand-off; FAILED if the rail rejected the batch outright. */
  status: Extract<OriginationBatchStatus, 'SUBMITTED' | 'FAILED'>;
  items: ProviderItemResult[];
  /** request/response breadcrumbs (NO secrets, NO PII) persisted to batches.trace. */
  trace: Record<string, unknown>;
}

/**
 * A status poll. `simulate` is honored ONLY by the SANDBOX adapter — it lets tests
 * and the demo drive a deterministic RETURN (or an outright FAILURE) without a
 * network. A real adapter IGNORES `simulate` and reports what the rail actually says.
 */
export interface StatusQuery {
  providerBatchRef: string;
  lines: OriginationLine[];
  simulate?: {
    /** force these items to RETURN with the given ACH return code (SANDBOX only). */
    returns?: Array<{ itemId: string; returnCode: string }>;
    /** force the whole batch to FAIL (SANDBOX only). */
    fail?: boolean;
  };
}

export interface StatusResult {
  status: OriginationBatchStatus;
  items: ProviderItemResult[];
  trace: Record<string, unknown>;
}

/**
 * The single seam every money-out origination provider plugs in behind.
 * `name` is the stable adapter id ('SANDBOX' | a real provider) recorded on the
 * batch so history shows which rail handled it.
 */
export interface OriginationProvider {
  readonly name: string;
  readonly rails: readonly OriginationRail[];
  /** true when the adapter has usable credentials (SANDBOX is always configured). */
  isConfigured(): boolean;
  submitBatch(input: SubmitBatchInput): Promise<SubmitBatchResult>;
  getStatus(query: StatusQuery): Promise<StatusResult>;
}

/** Thrown when a real provider adapter is invoked without usable credentials/config. */
export class OriginationProviderNotConfiguredError extends Error {
  constructor(message = 'origination provider not configured') {
    super(message);
    this.name = 'OriginationProviderNotConfiguredError';
  }
}
