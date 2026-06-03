/**
 * The one place that talks to Anthropic. Server-side only; the key is passed in
 * by the host (never read from env here, never client-side). No module imports
 * this directly — they go through the gateway.
 */

import type { ProviderCall } from './types';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export const callAnthropic: ProviderCall = async ({ apiKey, model, max_tokens, messages, system, params }) => {
  const body: Record<string, unknown> = {
    model,
    max_tokens,
    messages,
    ...(system ? { system } : {}),
    ...(params ?? {}),
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => null) as
    | { content?: unknown; model?: string; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } }
    | null;

  if (!res.ok || !json) {
    const msg = json?.error?.message ?? `Anthropic request failed (HTTP ${res.status})`;
    throw new Error(msg);
  }

  return {
    result: json.content ?? null,
    model_used: json.model ?? model,
    tokens: {
      input: Number(json.usage?.input_tokens ?? 0),
      output: Number(json.usage?.output_tokens ?? 0),
    },
  };
};
