/**
 * "AI is unavailable" classification for Merit Projects (port of apps/web
 * lib/ai/gateway.ts `isAiUnavailableError`, plus timeouts). Pure; safe anywhere.
 *
 * When the Anthropic org is disabled, the key is wrong, credit is exhausted, the
 * provider is overloaded, or our own 20-second timeout fires, the right outcome is
 * the calm "AI assist paused" state with the rules path still working, never a 5xx.
 */

export const AI_PAUSED_MESSAGE = 'AI assist is paused right now. Everything still works from the rules; it just takes a tap or two more.';

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '';
}

/** True when the error is a timeout or an abort (ours or the platform's). */
export function isTimeoutError(err: unknown): boolean {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = String((err as { name?: unknown }).name);
    if (name === 'AbortError' || name === 'TimeoutError') return true;
  }
  const msg = errorText(err).toLowerCase();
  return msg.includes('timed out') || msg.includes('timeout') || msg.includes('aborted');
}

/**
 * True when the provider/gateway error means the AI account itself can't be used
 * right now (as opposed to an application bug). Matches the embedded HTTP status
 * the provider puts in its message and the human-readable Anthropic error text.
 */
export function isAiUnavailableError(err: unknown): boolean {
  if (isTimeoutError(err)) return true;
  const msg = errorText(err).toLowerCase();
  if (!msg) return false;
  if (/\bhttp\s*(401|402|403|429|500|502|503|529)\b/.test(msg)) return true;
  const NEEDLES = [
    'disabled', 'deactivat', 'suspend', 'permission', 'not allowed', 'forbidden', 'unauthorized',
    'authentication', 'invalid x-api-key', 'invalid api key', 'api key', 'no api key', 'not configured',
    'credit balance', 'billing', 'quota', 'insufficient', 'overloaded', 'temporarily unavailable',
    'was blocked', 'fetch failed', 'econnreset', 'enotfound', 'network',
  ];
  return NEEDLES.some((n) => msg.includes(n));
}
