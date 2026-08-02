/**
 * Document-Intelligence provider resolution.
 *
 * `resolveDocProvider(deps)` picks the extraction engine for a call:
 *   - Azure Document Intelligence IF configured (endpoint + key present, from env
 *     today; per-tenant Vault later) → AzureDocIntelligenceProvider, constructed
 *     WITH the LLM provider as its runtime fallback.
 *   - otherwise → LlmVisionProvider (the gateway-routed working default).
 *
 * This mirrors the payroll `resolvePayrollEngine` shape (real provider when
 * configured, safe default otherwise) so no core capability depends on Azure
 * being wired. Never throws for the "no Azure" case.
 */

import type { DocIntelligenceProvider, DocProviderDeps } from './types';
import { LlmVisionProvider } from './llm-vision-provider';
import {
  AzureDocIntelligenceProvider,
  azureConfigFromEnv,
  type AzureDocIntelligenceConfig,
} from './azure-provider';

export interface ResolveDocProviderOptions {
  /** Override the Azure config (tests / future Vault-resolved per-tenant creds). */
  azureConfig?: AzureDocIntelligenceConfig;
}

/**
 * Resolve the active provider. `deps` carries the Supabase client + Anthropic key
 * the LLM provider needs; the LLM provider is always built (it is the fallback).
 */
export function resolveDocProvider(
  deps: DocProviderDeps,
  options: ResolveDocProviderOptions = {},
): DocIntelligenceProvider {
  const llm = new LlmVisionProvider(deps);

  const azureConfig = options.azureConfig ?? azureConfigFromEnv();
  const azure = new AzureDocIntelligenceProvider(azureConfig, llm);

  // Prefer Azure only when it is genuinely configured; otherwise the LLM engine.
  return azure.isConfigured() ? azure : llm;
}
