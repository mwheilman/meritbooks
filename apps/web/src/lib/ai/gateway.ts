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

/* -------------------------------------------------------------------------- */
/* Graceful "AI unavailable" degradation                                       */
/*                                                                             */
/* When the Anthropic org is disabled/suspended, the key is missing/invalid,   */
/* permission is denied, or the account's credit is exhausted, the provider    */
/* THROWS (see packages/core-ai/src/provider.ts) and that throw propagates      */
/* straight out of `runAiGateway`. Left unhandled it surfaces as a raw 500/502 */
/* to the user. These helpers let every AI seam classify that failure and      */
/* return one calm, typed "AI is paused" outcome instead of a stack trace.     */
/* -------------------------------------------------------------------------- */

/** Short, reassuring copy for the paused state. Kept here so server + client agree. */
export const AI_UNAVAILABLE_MESSAGE = 'AI is temporarily unavailable — try again later.';

/**
 * The typed body every AI/NL route returns when the model can't be reached. The
 * client keys off `unavailable` to render the calm inline notice (never a red
 * error toast or a crash). Routes spread this alongside their own empty/abstain
 * shape so deterministic fields (rows, candidates, draft:null) stay well-formed.
 */
export interface AiUnavailablePayload {
  unavailable: true;
  code: 'AI_UNAVAILABLE';
  message: string;
}

/** Build the standard "AI is paused" payload. */
export function aiUnavailablePayload(message: string = AI_UNAVAILABLE_MESSAGE): AiUnavailablePayload {
  return { unavailable: true, code: 'AI_UNAVAILABLE', message };
}

/**
 * Detect a thrown Anthropic/gateway error that means the AI ACCOUNT itself is
 * unusable — org disabled/suspended, key missing/invalid, permission denied, or
 * billing/credit exhausted — as opposed to an ordinary application bug. When true,
 * the caller should degrade to the calm paused state rather than a raw 5xx.
 *
 * The provider throws `Error(anthropicMessage)` on a JSON error body, or
 * `Error("Anthropic request failed (HTTP <status>)")` otherwise — so we match on
 * both the embedded HTTP status and the human-readable Anthropic error text.
 */
export function isAiUnavailableError(err: unknown): boolean {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!raw) return false;
  const msg = raw.toLowerCase();

  // Authorization / billing / rate HTTP statuses the provider surfaces on a
  // disabled org, a bad/absent key, or exhausted credit.
  if (/\bhttp\s*(401|402|403|429|529)\b/.test(msg)) return true;

  const NEEDLES = [
    'disabled',
    'deactivat',
    'suspend',
    'permission',
    'not allowed',
    'forbidden',
    'unauthorized',
    'authentication',
    'invalid x-api-key',
    'invalid api key',
    'api key',
    'no api key',
    'not configured',
    'credit balance',
    'billing',
    'quota',
    'insufficient',
    'overloaded',
    'temporarily unavailable',
    'was blocked',
  ];
  return NEEDLES.some((n) => msg.includes(n));
}
