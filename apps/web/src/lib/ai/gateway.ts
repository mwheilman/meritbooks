/**
 * Books-side entrypoint to the Core AI gateway.
 *
 * Canon §2 invariant: "No module holds an Anthropic key or calls the API
 * directly; every call routes through `@meritbooks/core-ai`, meters to
 * `core.ai_usage_log`, and the tenant monthly budget is enforced across COMBINED
 * suite usage." The Anthropic key exists in this module ONLY to be handed to
 * `runAiGateway` as a host-injected dependency (see `GatewayDeps.anthropicApiKey`);
 * it is never used to call Anthropic from app code.
 *
 * This is the SINGLE place in `apps/web` that reads `process.env.ANTHROPIC_API_KEY`.
 * Every AI seam (categorizer, JE composer, bill parser, exception predictor, the
 * interim HTTP bridge) obtains the key here and passes it through the gateway, so
 * the key never leaks into a direct provider call and every model call is metered.
 */

/**
 * The one reader of the Anthropic key from server env. Returns null when unset so
 * callers can degrade gracefully (503 / rule-based fallback) with their own copy.
 * Server-side only — never import this into a client component.
 */
export function getAnthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY ?? null;
}
