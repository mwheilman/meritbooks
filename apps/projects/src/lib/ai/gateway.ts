import 'server-only';
/**
 * Merit Projects → Core AI gateway. THE ONLY place in apps/projects that reads
 * `ANTHROPIC_API_KEY` or `SUPABASE_SERVICE_ROLE_KEY` (the gateway needs a
 * service-role client for metering: core.ai_usage_log, counters, rate limits).
 * The key is handed to `runAiGateway` as a host-injected dependency and is never
 * used to call Anthropic from app code (canon §2).
 *
 * `runAiSafe()` never throws; see ./gateway-core.ts for the outcome contract.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { runAiToolWith, type AiToolRequest, type AiToolResult } from './gateway-core';

export {
  FEATURE_IMPORT_MAP, FEATURE_PACK_CONFIGURE, PROJECTS_MODEL, type AiTool, type AiToolRequest, type AiToolResult,
} from './gateway-core';

let admin: SupabaseClient | null | undefined;

/** Service-role client for the gateway's metering only. Null when not configured. */
function gatewayAdminClient(): SupabaseClient | null {
  if (admin !== undefined) return admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  admin = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  return admin;
}

/** True when the host has what the gateway needs (it may still be paused upstream). */
export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) && gatewayAdminClient() !== null;
}

/** Forced-tool call through the Core gateway. Never throws. */
export async function runAiSafe(req: AiToolRequest): Promise<AiToolResult> {
  try {
    return await runAiToolWith(
      { apiKey: process.env.ANTHROPIC_API_KEY ?? null, supabase: gatewayAdminClient(), runGateway: runAiGateway },
      req,
    );
  } catch (err) {
    // runAiToolWith already never throws; this is belt and braces for env access.
    console.warn('[projects-ai] runAiSafe guard', err);
    return {
      status: 'unavailable', reason: 'error', message: 'AI assist is paused right now.',
      correlationId: null, modelRequested: req.model ?? 'unknown', modelUsed: null, tokens: { input: 0, output: 0 }, costCents: 0,
    };
  }
}
