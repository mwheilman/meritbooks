/**
 * The Merit Projects AI helper, without the environment (pure + injectable so it is
 * unit-tested). `./gateway.ts` binds it to the real env, admin client and Core
 * gateway. Contract:
 *
 *   runAiToolWith(deps, req) → AiToolResult        never throws
 *
 *   - missing key / admin client          → { status: 'unavailable', reason: 'not_configured' }
 *   - provider/gateway throw (401/402/403/429/529, "disabled", "credit balance", network…)
 *                                         → { status: 'unavailable', reason: 'provider' }
 *   - 20 s timeout (AbortController)      → { status: 'unavailable', reason: 'timeout' }
 *   - any other throw (a bug)             → { status: 'unavailable', reason: 'error' } (logged)
 *   - gateway status 'blocked'            → { status: 'blocked', message }
 *   - model answered without the tool     → { status: 'invalid' }
 *   - otherwise                           → { status: 'ok', input: <tool_use.input>, … }
 *
 * Every call is a FORCED tool call (`tool_choice: {type:'tool', name}`, temperature 0),
 * so the only thing we ever read back is the tool's JSON input, never prose.
 */
import type { GatewayDeps, GatewayRequest, GatewayResponse, ProviderCall } from '@meritbooks/core-ai';
import { AI_PAUSED_MESSAGE, errorText, isAiUnavailableError, isTimeoutError } from './unavailable';

export const PROJECTS_MODULE = 'PROJECTS';
export const FEATURE_PACK_CONFIGURE = 'PROJECTS_PACK_CONFIGURE';
export const FEATURE_IMPORT_MAP = 'PROJECTS_IMPORT_MAP';
/** One model id for Projects AI (the suite default today). */
export const PROJECTS_MODEL = 'claude-sonnet-4-6';
export const AI_TIMEOUT_MS = 20_000;

export interface AiTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AiToolRequest {
  orgId: string;
  userId: string | null;
  feature?: string;
  system: string;
  /** The user turn (plain text). */
  prompt: string;
  tool: AiTool;
  model?: string;
  maxTokens?: number;
}

export interface AiMeta {
  correlationId: string | null;
  modelRequested: string;
  modelUsed: string | null;
  tokens: { input: number; output: number };
  costCents: number;
}

export type AiToolResult =
  | ({ status: 'ok'; input: unknown; message: string | null } & AiMeta)
  | ({ status: 'invalid'; message: string } & AiMeta)
  | ({ status: 'blocked'; message: string } & AiMeta)
  | ({ status: 'unavailable'; reason: 'not_configured' | 'provider' | 'timeout' | 'error'; message: string } & AiMeta);

export type GatewayRunner = (deps: GatewayDeps, req: GatewayRequest) => Promise<GatewayResponse>;

export interface AiToolDeps {
  apiKey: string | null | undefined;
  /** Service-role Supabase client the Core gateway meters with (null when unconfigured). */
  supabase: unknown | null;
  runGateway: GatewayRunner;
  timeoutMs?: number;
  /** Provider override (tests). Default: an abortable Anthropic call. */
  callProvider?: ProviderCall;
  fetchImpl?: typeof fetch;
  log?: (msg: string, err?: unknown) => void;
}

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The Core provider call (packages/core-ai/src/provider.ts) with an AbortSignal, so
 * our timeout actually frees the socket. Injected into the gateway as
 * `deps.callProvider`; the gateway still does entitlement, budget and metering.
 */
export function abortableProvider(signal: AbortSignal, fetchImpl: typeof fetch = fetch): ProviderCall {
  return async ({ apiKey, model, max_tokens, messages, system, params }) => {
    const res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: JSON.stringify({ model, max_tokens, messages, ...(system ? { system } : {}), ...(params ?? {}) }),
    });
    const json = (await res.json().catch(() => null)) as
      | { content?: unknown; model?: string; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } }
      | null;
    if (!res.ok || !json) throw new Error(json?.error?.message ?? `Anthropic request failed (HTTP ${res.status})`);
    return {
      result: json.content ?? null,
      model_used: json.model ?? model,
      tokens: { input: Number(json.usage?.input_tokens ?? 0), output: Number(json.usage?.output_tokens ?? 0) },
    };
  };
}

/** The `input` of the first tool_use block named `name` in an Anthropic content array. */
export function extractToolInput(content: unknown, name: string): { found: true; input: unknown } | { found: false } {
  if (!Array.isArray(content)) return { found: false };
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as { type?: unknown; name?: unknown; input?: unknown };
      if (b.type === 'tool_use' && b.name === name) return { found: true, input: b.input ?? null };
    }
  }
  return { found: false };
}

class AiTimeout extends Error {
  constructor(ms: number) {
    super(`AI call timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

export async function runAiToolWith(deps: AiToolDeps, req: AiToolRequest): Promise<AiToolResult> {
  const model = req.model ?? PROJECTS_MODEL;
  const meta: AiMeta = { correlationId: null, modelRequested: model, modelUsed: null, tokens: { input: 0, output: 0 }, costCents: 0 };
  const log = deps.log ?? ((m: string, e?: unknown) => console.warn(`[projects-ai] ${m}`, e ?? ''));

  if (!deps.apiKey || !deps.supabase) {
    return { status: 'unavailable', reason: 'not_configured', message: AI_PAUSED_MESSAGE, ...meta };
  }

  const timeoutMs = deps.timeoutMs ?? AI_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiTimeout(timeoutMs));
    }, timeoutMs);
  });

  try {
    const gwReq: GatewayRequest = {
      tenant_id: req.orgId,
      user_id: req.userId,
      module: PROJECTS_MODULE,
      feature: req.feature ?? FEATURE_PACK_CONFIGURE,
      model,
      system: req.system,
      max_tokens: req.maxTokens ?? 1500,
      messages: [{ role: 'user', content: req.prompt }],
      params: { tools: [req.tool], tool_choice: { type: 'tool', name: req.tool.name }, temperature: 0 },
    };
    const gwDeps: GatewayDeps = {
      supabase: deps.supabase,
      anthropicApiKey: deps.apiKey,
      callProvider: deps.callProvider ?? abortableProvider(controller.signal, deps.fetchImpl),
    };
    const gw = await Promise.race([deps.runGateway(gwDeps, gwReq), timeout]);
    meta.correlationId = gw.correlation_id ?? null;
    meta.modelUsed = gw.model_used ?? null;
    meta.tokens = gw.tokens ?? meta.tokens;
    meta.costCents = gw.cost_cents ?? 0;

    if (gw.status === 'blocked') {
      return { status: 'blocked', message: gw.message ?? 'AI is not available for this workspace right now.', ...meta };
    }
    const tool = extractToolInput(gw.result, req.tool.name);
    if (!tool.found) {
      return { status: 'invalid', message: 'The model answered without using the tool.', ...meta };
    }
    return { status: 'ok', input: tool.input, message: gw.message ?? null, ...meta };
  } catch (err) {
    if (isTimeoutError(err)) return { status: 'unavailable', reason: 'timeout', message: AI_PAUSED_MESSAGE, ...meta };
    if (isAiUnavailableError(err)) return { status: 'unavailable', reason: 'provider', message: AI_PAUSED_MESSAGE, ...meta };
    log(`unexpected AI failure: ${errorText(err)}`, err);
    return { status: 'unavailable', reason: 'error', message: AI_PAUSED_MESSAGE, ...meta };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
