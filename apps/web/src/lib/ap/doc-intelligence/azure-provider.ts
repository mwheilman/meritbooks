/**
 * AzureDocIntelligenceProvider — high-fidelity OCR/layout extraction for scanned
 * invoices where LLM vision is insufficient (INTEGRATION-MAP §2.5).
 *
 * STATUS: scaffolded + BLOCKED on Azure creds (blocked since Session 22 per the
 * integration map). The class + method signatures are real and MUST NOT change;
 * the HTTP call to the Azure `prebuilt-invoice` model is marked TODO where the
 * live response shape must be confirmed against a sandbox.
 *
 * DEGRADE-BY-DEFAULT (mirrors the payroll CheckPayrollEngine → Mock pattern):
 *   - `isConfigured()` is false unless BOTH an endpoint and a key are present.
 *   - When unconfigured, `resolveDocProvider` never even constructs this — it
 *     returns the LLM provider. When constructed WITH a fallback and the Azure
 *     call is unavailable/not-yet-wired, `extractBill` degrades to the fallback
 *     (the gateway-routed LLM provider) rather than crashing.
 *
 * SECURITY: the Azure key is a platform/Vault secret, resolved server-side and
 * passed in via config. Never logged, serialized, or shipped to the browser.
 */

import type {
  DocIntelligenceProvider,
  DocumentInput,
  DocExtractionResult,
} from './types';
import { DocProviderNotConfiguredError } from './types';

export const AZURE_DOC_INTELLIGENCE_PROVIDER_NAME = 'azure-doc-intelligence';

export interface AzureDocIntelligenceConfig {
  /** Azure Document Intelligence endpoint, e.g. https://<res>.cognitiveservices.azure.com. */
  endpoint: string | null;
  /** Azure API key (Vault/platform secret). Server-only; never logged. */
  apiKey: string | null;
  /** Model id — defaults to the prebuilt invoice model. */
  modelId?: string;
  /** API version query param. */
  apiVersion?: string;
}

const DEFAULT_MODEL_ID = 'prebuilt-invoice';
const DEFAULT_API_VERSION = '2024-11-30';

/**
 * Read Azure config from environment variables. Per-tenant Vault-backed config
 * (via `core.provider_connections`) is intended once a `DOC_INTELLIGENCE`
 * capability lands (REPORTED — the enum today is AR_COLLECTION/AP_DISBURSEMENT/
 * PAYROLL/BANK_FEED). Until then, platform-level env config is the seam.
 */
export function azureConfigFromEnv(): AzureDocIntelligenceConfig {
  return {
    endpoint: process.env.AZURE_DOC_INTELLIGENCE_ENDPOINT ?? null,
    apiKey: process.env.AZURE_DOC_INTELLIGENCE_KEY ?? null,
    modelId: process.env.AZURE_DOC_INTELLIGENCE_MODEL ?? DEFAULT_MODEL_ID,
    apiVersion: process.env.AZURE_DOC_INTELLIGENCE_API_VERSION ?? DEFAULT_API_VERSION,
  };
}

export class AzureDocIntelligenceProvider implements DocIntelligenceProvider {
  readonly name = AZURE_DOC_INTELLIGENCE_PROVIDER_NAME;

  private readonly config: AzureDocIntelligenceConfig;
  private readonly fallback: DocIntelligenceProvider | null;

  /**
   * @param config   Azure creds (from env or Vault).
   * @param fallback The provider to degrade to when Azure is unavailable — always
   *                 the gateway-routed LLM provider in production. Optional so the
   *                 provider can also be used strictly (throws when unconfigured).
   */
  constructor(config: AzureDocIntelligenceConfig, fallback: DocIntelligenceProvider | null = null) {
    this.config = config;
    this.fallback = fallback;
  }

  /** Configured only when BOTH an endpoint and a key are present. */
  isConfigured(): boolean {
    return Boolean(this.config.endpoint && this.config.apiKey);
  }

  async extractBill(document: DocumentInput): Promise<DocExtractionResult> {
    if (!this.isConfigured()) {
      // Unconfigured → degrade to the LLM provider if we were given one.
      if (this.fallback) return this.fallback.extractBill(document);
      throw new DocProviderNotConfiguredError(
        'Azure Document Intelligence not configured: endpoint/key missing',
      );
    }

    // TODO(GATE 4 — blocked on Azure creds): POST the document to
    //   `${endpoint}/documentintelligence/documentModels/${modelId}:analyze?api-version=${apiVersion}`
    // with header `Ocp-Apim-Subscription-Key: ${apiKey}`, poll the operation-location
    // for completion, then map the `analyzeResult` invoice fields
    // (VendorName, InvoiceId, InvoiceDate, DueDate, SubTotal, TotalTax, InvoiceTotal, Items[])
    // onto ExtractedBill (amounts → bigint cents). AI then reconciles OCR fields
    // vs the LLM extraction (integration map §2.5). Until that path is verified
    // against a live sandbox, we do not silently return unvalidated OCR — we
    // degrade to the proven LLM extraction so intake keeps working.
    if (this.fallback) return this.fallback.extractBill(document);

    return {
      ok: false,
      error:
        'Azure Document Intelligence extraction is scaffolded but not yet wired to a live endpoint (GATE 4).',
    };
  }
}

// Re-export the error type name so consumers can `import type` it from here too.
export type { _NotConfigured };
