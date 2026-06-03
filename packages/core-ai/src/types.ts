/**
 * Merit Suite Core — AI Gateway types (Architecture §3A.6).
 *
 * The module-facing request/response contract. Core-owned; identical for every
 * module. No module sees total spend — only the budget state for its own call.
 */

export type GatewayStatus = 'ok' | 'warn' | 'degraded' | 'blocked';
export type BudgetState = 'under' | 'soft' | 'hard';

/** A chat message passed through to the provider. */
export interface GatewayMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

/** Request: module -> gateway (§3A.6). */
export interface GatewayRequest {
  tenant_id: string;          // core.organizations.id
  user_id: string | null;     // Clerk user id (text); null for system calls
  module: string;             // 'BOOKS' | 'PROJECTS' | ...
  feature: string;            // the module's declared feature bucket
  model: string;              // requested model; gateway may substitute on degrade
  messages?: GatewayMessage[];
  system?: string;
  params?: Record<string, unknown>;
  max_tokens?: number;        // optional; capped to the Core per-call ceiling (§3A.5)
  /**
   * Core verification affordance (not part of the public §3A.6 body): when true the
   * gateway runs the FULL path — entitlement, guards, budget, metering, counters,
   * logging — but does NOT call Anthropic and incurs no spend. `sim_tokens` lets a
   * verifier simulate usage so counters/log move. Used by the Sandbox/self-test.
   */
  dry_run?: boolean;
  sim_tokens?: { input: number; output: number };
}

export interface GatewayBudget {
  state: BudgetState;
  tenant_pct_used: number;
  user_pct_used?: number;     // present if a per-user sub-budget exists
  feature_pct_used?: number;  // present if a per-feature cap exists
}

/** Response: gateway -> module (§3A.6). */
export interface GatewayResponse {
  status: GatewayStatus;
  result: unknown | null;     // model output, or null when blocked
  model_used: string | null;  // may differ from requested when degraded
  tokens: { input: number; output: number };
  cost_cents: number;
  budget: GatewayBudget;
  correlation_id: string;     // links to the ai_usage_log row and the module's audit log
  message: string | null;
}

/** Resolved tier configuration (from core.ai_tier_config + the org's ai_tier). */
export interface TierConfig {
  tier: string;
  monthly_cap_cents: number | null;
  per_user_cap_cents: number | null;
  soft_warn_pct: number;
  overage_policy: 'HARD_STOP' | 'METERED' | 'UPSELL' | 'DEGRADE_MODEL';
  degrade_model: string | null;
  max_tokens_ceiling: number;
  rate_per_user_per_min: number | null;
  rate_per_tenant_per_min: number | null;
  concurrency_limit: number | null;
}

/** Dependencies injected by the host (keeps the package deployment-agnostic). */
export interface GatewayDeps {
  /** Supabase admin client (service role). The gateway is trusted Core code. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  /** Anthropic API key — supplied by the host from server env; never hardcoded. */
  anthropicApiKey: string;
  /** Override the provider call (tests/sandbox). Defaults to the real Anthropic call. */
  callProvider?: ProviderCall;
  /** Concurrency in-flight TTL (seconds) before a slot is reaped. Default 120. */
  inflightTtlSeconds?: number;
}

export interface ProviderResult {
  result: unknown;
  model_used: string;
  tokens: { input: number; output: number };
}

export type ProviderCall = (args: {
  apiKey: string;
  model: string;
  max_tokens: number;
  messages: GatewayMessage[];
  system?: string;
  params?: Record<string, unknown>;
}) => Promise<ProviderResult>;
