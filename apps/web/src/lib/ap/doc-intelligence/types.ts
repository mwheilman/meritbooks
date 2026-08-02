/**
 * AP Document-Intelligence provider contract.
 *
 * A single seam behind which any invoice-extraction engine plugs in:
 *   - LlmVisionProvider  — the working default; routes the document through the
 *     Core AI gateway (`@meritbooks/core-ai`) exactly like the existing bill-parse.
 *   - AzureDocIntelligenceProvider — high-fidelity OCR/layout for scanned invoices
 *     where LLM vision is insufficient. Reads creds from env/Vault; degrades to the
 *     LLM provider when unconfigured (mirrors the payroll provider-agnostic pattern).
 *
 * SAFETY (canon §3): extraction is AI proposing FACTS. Nothing here posts to the
 * GL or creates a payable — a provider returns structured fields + confidence, and
 * a human reviews the resulting DRAFT before the gated `/api/bills/create` runs.
 *
 * DO NOT RENAME these types or their members — routes, the resolver, and other
 * agents build against them.
 */

/** The raw document handed to a provider. Base64 keeps it transport-agnostic. */
export interface DocumentInput {
  /** Base64-encoded file bytes (PDF or image). */
  base64: string;
  /** MIME type, e.g. 'application/pdf' | 'image/png'. */
  mediaType: string;
  /** Original file name (for audit/summary only). */
  fileName: string;
  /** Tenant org id — scopes the gateway call and metering. */
  orgId: string;
  /** Clerk user id for attribution; null for system/inbox runs. */
  userId?: string | null;
}

/** One extracted invoice line. Amounts are bigint cents (canon: never floats). */
export interface ExtractedBillLine {
  description: string;
  quantity: number;
  unitCostCents: number;
  amountCents: number;
  /** Provider's category hint (MATERIALS, LABOR, …) — a facts hint, not a GL code. */
  categoryHint: string | null;
  confidence: number;
}

/** The structured fields a provider returns for one vendor invoice. */
export interface ExtractedBill {
  vendorName: string;
  vendorNameConfidence: number;
  invoiceNumber: string | null;
  invoiceNumberConfidence: number;
  invoiceDate: string | null; // YYYY-MM-DD
  invoiceDateConfidence: number;
  dueDate: string | null; // YYYY-MM-DD
  dueDateConfidence: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  totalConfidence: number;
  currency: string;
  lines: ExtractedBillLine[];
  /** Free-form notes the model/OCR surfaced (handwriting, ambiguity, …). */
  notes: string;
  /** Which engine produced this ('llm-vision' | 'azure-doc-intelligence'). */
  providerName: string;
  /** The model/engine version actually used. */
  engineVersion: string;
  /** Wall-clock extraction time in ms. */
  extractionMs: number;
}

export type DocExtractionResult =
  | { ok: true; bill: ExtractedBill }
  | {
      ok: false;
      error: string;
      /** True when the AI gateway blocked the call for budget/entitlement reasons. */
      budgetBlocked?: boolean;
    };

/**
 * Per-call dependencies. Kept explicit (not global) so the provider layer stays
 * host-agnostic and unit-testable.
 */
export interface DocProviderDeps {
  /** RLS-scoped or admin Supabase client (the gateway meters via the injected client). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  /** Anthropic key, injected into the Core AI gateway. Server-only; never logged. */
  anthropicApiKey: string;
}

/** The single seam every extraction engine implements. */
export interface DocIntelligenceProvider {
  /** Stable engine id, surfaced in the DRAFT + audit. */
  readonly name: string;
  /** True when this engine has everything it needs to run for real. */
  isConfigured(): boolean;
  /** Extract structured bill fields from a document. Never throws for the expected
   * failure cases — returns `{ ok: false, … }` so callers can degrade cleanly. */
  extractBill(document: DocumentInput): Promise<DocExtractionResult>;
}

/** Thrown only when a provider is asked to run while genuinely unconfigured. */
export class DocProviderNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocProviderNotConfiguredError';
  }
}
