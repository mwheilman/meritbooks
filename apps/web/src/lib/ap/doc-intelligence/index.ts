/**
 * AP Document-Intelligence — provider-agnostic invoice extraction + intake queue.
 * One import surface for routes and the review UI.
 */

export * from './types';
export { LlmVisionProvider, LLM_VISION_PROVIDER_NAME } from './llm-vision-provider';
export {
  AzureDocIntelligenceProvider,
  AZURE_DOC_INTELLIGENCE_PROVIDER_NAME,
  azureConfigFromEnv,
  type AzureDocIntelligenceConfig,
} from './azure-provider';
export { resolveDocProvider, type ResolveDocProviderOptions } from './resolve';
export {
  createDocIntakeDraft,
  createInboundIntakeDraft,
  listDocIntakeDrafts,
  getDocIntakeDraft,
  disposeDocIntakeDraft,
  assembleCreateBillPayload,
  AP_DOC_INTAKE_FEATURE,
  type DocIntakeProposal,
  type DocIntakeDraft,
  type DocIntakeSource,
  type DocIntakeParseState,
  type DocIntakeInbound,
  type CreateDraftArgs,
  type CreateDraftResult,
  type CreateInboundDraftArgs,
  type CreateInboundDraftResult,
  type DraftResolution,
  type DisposeAction,
} from './intake-queue';
