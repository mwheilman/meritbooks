/**
 * @meritbooks/core-ai — Merit Suite Core AI Gateway (Architecture §3A).
 *
 * Core-owned shared infrastructure. The single server-side path to Anthropic and
 * the single point where metering and budget caps are enforced, across ALL modules.
 * Books-agnostic: any module calls `runAiGateway` (in-process) or the Core HTTP
 * route that wraps it, with the identical §3A.6 request/response contract.
 *
 * Writes only to Core-owned tables in the `core` schema (migration 027).
 */

export { runAiGateway, tokensToCents } from './gateway';
export { callAnthropic } from './provider';
export { currentPeriodMonth } from './store';
export { createHttpGatewayClient, SERVICE_TOKEN_HEADER } from './httpClient';
export type { HttpGatewayClientConfig } from './httpClient';
export type {
  GatewayRequest, GatewayResponse, GatewayStatus, GatewayBudget, GatewayMessage,
  GatewayDeps, TierConfig, BudgetState, ProviderCall, ProviderResult,
} from './types';
