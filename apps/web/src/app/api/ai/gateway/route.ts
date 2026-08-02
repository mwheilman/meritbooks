export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { runAiGateway, SERVICE_TOKEN_HEADER, type GatewayRequest } from '@meritbooks/core-ai';

/**
 * POST /api/ai/gateway — INTERIM HTTP BRIDGE (Architecture §3A.9).
 *
 * The CANONICAL inter-module path is in-process import of `runAiGateway` from
 * `@meritbooks/core-ai`. This HTTP route exists only while Books and Projects run as
 * separate deployments; it is retired at single-app merge. Do not over-build it.
 *
 * Auth (interim only): per-module shared service token in the `x-merit-service-token`
 * header, verified against env. Attribution: the caller asserts tenant_id/user_id and
 * the bridge verifies the user has an ACTIVE core.memberships row in that tenant before
 * honoring (Identity/Access §4). Agent/system calls pass user_id = null (tenant-scoped
 * service principal, authorized by the token alone). At merge, identity comes from the
 * in-app Clerk session and this assert-and-verify step falls away.
 */

type Supa = ReturnType<typeof createAdminSupabase>;

/**
 * Parse env `AI_GATEWAY_SERVICE_TOKENS` of the form "MODULE:token,MODULE2:token2".
 * No env configured => the bridge is disabled (fail closed).
 */
function resolveServiceTokens(): Map<string, string> {
  const raw = process.env.AI_GATEWAY_SERVICE_TOKENS ?? '';
  const map = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const mod = pair.slice(0, idx).trim().toUpperCase();
    const tok = pair.slice(idx + 1).trim();
    if (mod && tok) map.set(mod, tok);
  }
  return map;
}

/**
 * Verify the asserted user has an active membership in the asserted tenant.
 * Fail CLOSED: if core.memberships/core.users are not yet deployed, or no active
 * row exists, deny. (Per Identity/Access §4 — assumed shape below; confirm the exact
 * column names when Core ships the memberships migration.)
 *   core.users(id uuid, clerk_user_id text)
 *   core.memberships(user_id uuid -> core.users.id, organization_id uuid, status text)
 */
async function verifyActiveMembership(supabase: Supa, tenantId: string, assertedUserId: string): Promise<boolean> {
  try {
    const { data: user, error: uErr } = await supabase
      .schema('core').from('users')
      .select('id')
      .or(`clerk_user_id.eq.${assertedUserId},id.eq.${assertedUserId}`)
      .maybeSingle();
    if (uErr || !user) return false;

    const { data: m, error: mErr } = await supabase
      .schema('core').from('memberships')
      .select('id')
      .eq('user_id', (user as { id: string }).id)
      .eq('organization_id', tenantId)
      .eq('status', 'active')
      .maybeSingle();
    return !mErr && !!m;
  } catch {
    return false; // table absent / any error => deny
  }
}

export async function POST(request: Request) {
  // ── Interim S2S auth: per-module shared service token ──────────────────────
  const tokens = resolveServiceTokens();
  if (tokens.size === 0) {
    return NextResponse.json(
      { error: 'AI gateway HTTP bridge is not enabled (no AI_GATEWAY_SERVICE_TOKENS configured)' },
      { status: 503 }
    );
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const moduleName = typeof raw.module === 'string' ? raw.module.toUpperCase() : '';
  const feature = typeof raw.feature === 'string' ? raw.feature : '';
  const model = typeof raw.model === 'string' ? raw.model : '';
  const tenantId = typeof raw.tenant_id === 'string' ? raw.tenant_id : '';
  const userId = typeof raw.user_id === 'string' && raw.user_id ? raw.user_id : null;

  const presented = request.headers.get(SERVICE_TOKEN_HEADER) ?? '';
  const expected = tokens.get(moduleName);
  if (!expected || presented !== expected) {
    return NextResponse.json({ error: 'Invalid or missing service token' }, { status: 401 });
  }

  if (!moduleName || !feature || !model || !tenantId) {
    return NextResponse.json({ error: 'module, feature, model, and tenant_id are required' }, { status: 422 });
  }

  const supabase = createAdminSupabase();

  // ── Attribution: verify asserted user's active membership; null = service principal ──
  if (userId !== null) {
    const ok = await verifyActiveMembership(supabase, tenantId, userId);
    if (!ok) {
      return NextResponse.json(
        { error: 'Asserted user has no active membership in the asserted tenant' },
        { status: 403 }
      );
    }
  }

  const apiKey = getAnthropicApiKey() ?? '';
  const gwReq: GatewayRequest = {
    tenant_id: tenantId,
    user_id: userId,
    module: moduleName,
    feature,
    model,
    messages: Array.isArray(raw.messages) ? (raw.messages as GatewayRequest['messages']) : [],
    system: typeof raw.system === 'string' ? raw.system : undefined,
    params: typeof raw.params === 'object' && raw.params !== null ? (raw.params as Record<string, unknown>) : undefined,
    max_tokens: typeof raw.max_tokens === 'number' ? raw.max_tokens : undefined,
    dry_run: raw.dry_run === true,
    sim_tokens:
      raw.sim_tokens && typeof raw.sim_tokens === 'object'
        ? (raw.sim_tokens as { input: number; output: number })
        : undefined,
  };

  try {
    const response = await runAiGateway({ supabase, anthropicApiKey: apiKey }, gwReq);
    // Outcome is encoded in `status` (ok|warn|degraded|blocked); HTTP stays 200 so the
    // caller reads the §3A.6 shape rather than catching HTTP errors.
    return NextResponse.json(response);
  } catch (err) {
    console.error('[ai/gateway] error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Gateway error', code: 'GATEWAY_ERROR' },
      { status: 500 }
    );
  }
}
