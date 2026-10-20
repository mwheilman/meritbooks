import { describe, expect, it, vi } from 'vitest';
import type { GatewayDeps, GatewayRequest, GatewayResponse } from '@meritbooks/core-ai';
import { abortableProvider, extractToolInput, runAiToolWith, type AiToolRequest } from './gateway-core';
import { isAiUnavailableError } from './unavailable';

const tool = { name: 'propose_configuration', description: 'x', input_schema: { type: 'object' } };
const req: AiToolRequest = { orgId: 'org-1', userId: 'user_1', system: 'sys', prompt: 'hello', tool };

function gwResponse(over: Partial<GatewayResponse> = {}): GatewayResponse {
  return {
    status: 'ok',
    result: [{ type: 'tool_use', name: 'propose_configuration', input: { packs: [] } }],
    model_used: 'claude-sonnet-4-6',
    tokens: { input: 10, output: 5 },
    cost_cents: 1,
    budget: { state: 'under', tenant_pct_used: 0 },
    correlation_id: 'corr-1',
    message: null,
    ...over,
  };
}

const deps = (runGateway: (d: GatewayDeps, r: GatewayRequest) => Promise<GatewayResponse>, over = {}) => ({
  apiKey: 'sk-test', supabase: {}, runGateway, log: () => {}, ...over,
});

describe('runAiToolWith — never throws', () => {
  it('missing key → unavailable (not_configured), gateway never called', async () => {
    const run = vi.fn();
    const r = await runAiToolWith({ apiKey: null, supabase: {}, runGateway: run }, req);
    expect(r).toMatchObject({ status: 'unavailable', reason: 'not_configured' });
    expect(run).not.toHaveBeenCalled();
  });

  it('missing admin client → unavailable', async () => {
    const r = await runAiToolWith({ apiKey: 'k', supabase: null, runGateway: vi.fn() }, req);
    expect(r.status).toBe('unavailable');
  });

  it.each([
    'Your credit balance is too low to access the Anthropic API.',
    'Anthropic request failed (HTTP 529)',
    'Anthropic request failed (HTTP 429)',
    'Anthropic request failed (HTTP 401)',
    'This organization has been disabled.',
  ])('provider throw "%s" → unavailable (provider)', async (msg) => {
    const r = await runAiToolWith(deps(async () => { throw new Error(msg); }), req);
    expect(r).toMatchObject({ status: 'unavailable', reason: 'provider' });
  });

  it('an unexpected bug is still caught → unavailable (error)', async () => {
    const r = await runAiToolWith(deps(async () => { throw new TypeError('cannot read properties of undefined'); }), req);
    expect(r).toMatchObject({ status: 'unavailable', reason: 'error' });
  });

  it('a hung gateway times out → unavailable (timeout)', async () => {
    const r = await runAiToolWith(deps(() => new Promise<GatewayResponse>(() => {}), { timeoutMs: 15 }), req);
    expect(r).toMatchObject({ status: 'unavailable', reason: 'timeout' });
  });

  it('blocked by entitlement/budget → blocked', async () => {
    const r = await runAiToolWith(deps(async () => gwResponse({ status: 'blocked', result: null, message: 'Module "PROJECTS" is not entitled' })), req);
    expect(r).toMatchObject({ status: 'blocked' });
  });

  it('answer without the tool → invalid', async () => {
    const r = await runAiToolWith(deps(async () => gwResponse({ result: [{ type: 'text', text: 'Sure! HVAC.' }] })), req);
    expect(r.status).toBe('invalid');
  });

  it('forces the tool and returns its input', async () => {
    let seen: GatewayRequest | null = null;
    const r = await runAiToolWith(deps(async (_d, gr) => { seen = gr; return gwResponse(); }), req);
    expect(r).toMatchObject({ status: 'ok', input: { packs: [] }, correlationId: 'corr-1' });
    expect(seen!.module).toBe('PROJECTS');
    expect(seen!.feature).toBe('PROJECTS_PACK_CONFIGURE');
    expect(seen!.params).toEqual({ tools: [tool], tool_choice: { type: 'tool', name: 'propose_configuration' }, temperature: 0 });
  });

  it('degraded (model substituted) still returns the tool input', async () => {
    const r = await runAiToolWith(deps(async () => gwResponse({ status: 'degraded', model_used: 'claude-haiku-4-5' })), req);
    expect(r).toMatchObject({ status: 'ok', modelUsed: 'claude-haiku-4-5' });
  });
});

describe('abortableProvider', () => {
  it('passes the abort signal and throws the provider message on non-2xx', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(controller.signal);
      return new Response(JSON.stringify({ error: { message: 'Your credit balance is too low' } }), { status: 400 });
    });
    const call = abortableProvider(controller.signal, fetchImpl as unknown as typeof fetch);
    await expect(call({ apiKey: 'k', model: 'm', max_tokens: 10, messages: [] })).rejects.toThrow(/credit balance/);
  });
});

describe('helpers', () => {
  it('extractToolInput finds the named tool_use block only', () => {
    expect(extractToolInput([{ type: 'text', text: 'x' }, { type: 'tool_use', name: 't', input: { a: 1 } }], 't')).toEqual({ found: true, input: { a: 1 } });
    expect(extractToolInput([{ type: 'tool_use', name: 'other', input: {} }], 't')).toEqual({ found: false });
    expect(extractToolInput(null, 't')).toEqual({ found: false });
  });
  it('isAiUnavailableError ignores ordinary bugs', () => {
    expect(isAiUnavailableError(new Error('x is not a function'))).toBe(false);
    expect(isAiUnavailableError(new Error('Anthropic request failed (HTTP 402)'))).toBe(true);
  });
});
