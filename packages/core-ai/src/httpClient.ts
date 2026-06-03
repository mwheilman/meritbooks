/**
 * Interim HTTP client for the AI gateway (Architecture §3A.9 — bridge only).
 *
 * A separately-deployed module imports this and calls the gateway over HTTP while
 * deployments are still split. The base URL comes from the CALLING module's config
 * (env), never hardcoded — so the cutover at single-app merge is a one-line swap of
 * `createHttpGatewayClient({...})` for an in-process `runAiGateway(deps, ...)` import,
 * not a rewrite. Both return the identical §3A.6 response shape.
 *
 * This whole path is retired at merge. Do not over-build on top of it.
 */

import type { GatewayRequest, GatewayResponse } from './types';

export interface HttpGatewayClientConfig {
  /** Gateway base URL, supplied by the calling module's config/env. NEVER hardcode. */
  baseUrl: string;
  /** Per-module shared service token (the interim S2S secret). */
  serviceToken: string;
  /** Optional fetch override (tests). */
  fetchImpl?: typeof fetch;
}

const GATEWAY_PATH = '/api/ai/gateway';
export const SERVICE_TOKEN_HEADER = 'x-merit-service-token';

export function createHttpGatewayClient(cfg: HttpGatewayClientConfig) {
  if (!cfg.baseUrl) throw new Error('createHttpGatewayClient: baseUrl is required (from config, not hardcoded)');
  const f = cfg.fetchImpl ?? fetch;
  const url = cfg.baseUrl.replace(/\/+$/, '') + GATEWAY_PATH;

  /** Call the gateway. `req` asserts tenant_id/user_id; the bridge verifies them. */
  return async function callGateway(req: GatewayRequest): Promise<GatewayResponse> {
    const res = await f(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SERVICE_TOKEN_HEADER]: cfg.serviceToken,
      },
      body: JSON.stringify(req),
    });
    return (await res.json()) as GatewayResponse;
  };
}
