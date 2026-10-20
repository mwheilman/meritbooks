export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { logHumanAction } from '@/lib/trust/action-log';
import {
  POLICY_BOUNDS,
  ipInCidr,
  isValidCidr,
  normalizeSecurityPolicy,
  policyIsOff,
  policyLoosenings,
  type SecurityPolicy,
} from '@/lib/auth/session-policy';
import { assertSessionMeetsPolicy, loadSecurityPolicy, type LoadedSecurityPolicy } from '@/lib/auth/assert-session-policy';
import { requestClientIp } from '@/lib/auth/client-ip';

/**
 * Tenant security policy (05-RBAC §3.8, R-7) — Settings → Security.
 *
 * GET  the policy, the IP allowlists, and what Clerk reports about THIS session
 *      (factor-verification age, client IP) so an admin can see, before switching a
 *      policy on, whether it can be verified (the dev Clerk instance may not send
 *      every claim).
 * PUT  replace the policy + allowlists. core.organizations / core.ip_allowlists are
 *      service-role-write only (migrations 154 / 167): written here after the
 *      settings_system:edit check, pinned to the session org, through
 *      core.replace_security_policy (mig 170) — the policy update and the allowlist
 *      delete + insert are ONE transaction, and the change (before / after, loosening
 *      flag, reason, IP) is written to core.access_change_log.
 *
 * LOOSENING GUARD (wave 2G): a change that RELAXES the current policy (two-factor off,
 * re-verification / session / idle limits removed or raised, allowlist off or widened)
 * is accepted only from a session that meets the CURRENT policy
 * (assertSessionMeetsPolicy, action configure_locked) — a stale or stolen session can't
 * switch off the controls that would stop it. Tightening is never gated.
 *
 * LOCKOUT GUARD: enforcing an IP allowlist that does not contain the admin's own
 * current address is refused (409) — the admin would lock themselves out of money
 * release.
 */

interface SessionInfo {
  factorVerificationAge: [number, number] | null;
  secondFactorVerified: boolean | null;
  clientIp: string | null;
}

async function sessionInfo(): Promise<SessionInfo> {
  const a = await auth().catch(() => null);
  const fva = (a as { factorVerificationAge?: [number, number] | null } | null)?.factorVerificationAge ?? null;
  return { factorVerificationAge: fva, secondFactorVerified: fva ? fva[1] >= 0 : null, clientIp: requestClientIp() };
}

interface AllowlistRow { id: string; name: string; cidrs: string[] }

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'settings_system', 'view');
  if (!guard.ok) return guard.response;

  const admin = createAdminSupabase();
  const { data: org, error } = await admin
    .schema('core').from('organizations')
    .select('security_policy')
    .eq('id', orgId)
    .maybeSingle();
  if (error) {
    if (error.code === '42703') {
      return NextResponse.json({ available: false, error: 'Security policy storage is not migrated yet (migration 167).' }, { status: 503 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const { data: lists, error: lerr } = await admin
    .schema('core').from('ip_allowlists')
    .select('id, name, cidrs')
    .eq('org_id', orgId)
    .order('name');
  if (lerr) return NextResponse.json({ error: lerr.message }, { status: 500 });

  const policy = normalizeSecurityPolicy((org as { security_policy: unknown } | null)?.security_policy);
  return NextResponse.json({
    available: true,
    policy,
    policyOff: policyIsOff(policy),
    allowlists: ((lists ?? []) as AllowlistRow[]).map((l) => ({ id: l.id, name: l.name, cidrs: l.cidrs ?? [] })),
    session: await sessionInfo(),
    bounds: POLICY_BOUNDS,
  });
}

const cidr = z.string().trim().min(1).max(64).refine(isValidCidr, { message: 'Not a valid IP address or CIDR range' });

const putSchema = z.object({
  policy: z.object({
    mfa_all_staff: z.boolean(),
    default_step_up_minutes: z.number().int().min(0).max(POLICY_BOUNDS.stepUpMinutes.max),
    session_max_hours: z.number().int().min(POLICY_BOUNDS.sessionMaxHours.min).max(POLICY_BOUNDS.sessionMaxHours.max).nullable(),
    idle_timeout_minutes: z.number().int().min(POLICY_BOUNDS.idleTimeoutMinutes.min).max(POLICY_BOUNDS.idleTimeoutMinutes.max).nullable(),
    ip_allowlist_enforced: z.boolean(),
  }),
  allowlists: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    cidrs: z.array(cidr).max(100),
  })).max(20),
  /** Why (recorded in the access log). Optional. */
  reason: z.string().trim().max(500).optional(),
});

export async function PUT(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;

  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.issues },
      { status: 422 },
    );
  }
  const names = parsed.data.allowlists.map((l) => l.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    return NextResponse.json({ error: 'Allowlist names must be unique', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const policy: SecurityPolicy = normalizeSecurityPolicy(parsed.data.policy);
  const allCidrs = parsed.data.allowlists.flatMap((l) => l.cidrs);

  // Lockout guard for the IP allowlist.
  if (policy.ip_allowlist_enforced) {
    if (allCidrs.length === 0) {
      return NextResponse.json({ error: 'Add at least one network before enforcing the IP allowlist.', code: 'ALLOWLIST_EMPTY' }, { status: 409 });
    }
    const { clientIp } = await sessionInfo();
    if (!clientIp || !allCidrs.some((c) => ipInCidr(clientIp, c))) {
      return NextResponse.json({
        error: `Your current address${clientIp ? ` (${clientIp})` : ''} is not in the allowlist — enforcing it would lock you out of money release.`,
        code: 'ALLOWLIST_LOCKOUT',
      }, { status: 409 });
    }
  }

  const admin = createAdminSupabase();

  // Loosening guard: compare against the CURRENT stored policy (before anything is written).
  let current: LoadedSecurityPolicy;
  try {
    current = await loadSecurityPolicy(admin, orgId);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not read the current policy' }, { status: 503 });
  }
  const loosenings = policyLoosenings(current.policy, current.cidrs, policy, allCidrs);
  if (loosenings.length > 0) {
    const sp = await assertSessionMeetsPolicy({ orgId, userId }, { action: 'configure_locked' });
    if (!sp.ok) return sp.response;
  }

  // Attribution for the access log (core.users.id; null when the seat can't be resolved).
  const { data: actorRow } = await admin.schema('core').from('users').select('id').eq('clerk_user_id', userId).maybeSingle();
  const actorUserId = (actorRow as { id: string } | null)?.id ?? null;

  const { error: rpcErr } = await admin.schema('core').rpc('replace_security_policy', {
    p_org: orgId,
    p_policy: policy,
    p_allowlists: parsed.data.allowlists.map((l) => ({ name: l.name, cidrs: [...new Set(l.cidrs)] })),
    p_actor: actorUserId,
    p_actor_clerk: userId,
    p_loosening: loosenings.length > 0,
    p_reason: parsed.data.reason ?? (loosenings.length > 0 ? `Relaxed: ${loosenings.join(', ')}` : null),
    p_ip: requestClientIp(),
  });
  if (rpcErr) {
    if (rpcErr.code === '42883' || rpcErr.code === 'PGRST202') {
      return NextResponse.json({ error: 'Security policy storage is not migrated yet (migration 170).', code: 'NOT_MIGRATED' }, { status: 503 });
    }
    const status = rpcErr.code === '23514' || rpcErr.code === '23505' ? 422 : 500;
    return NextResponse.json({ error: rpcErr.message, code: status === 422 ? 'VALIDATION_ERROR' : 'DB_ERROR' }, { status });
  }

  await logHumanAction(admin, userId, orgId, {
    action: 'settings.security_policy.update',
    subjectTable: 'organizations',
    subjectId: orgId,
    summary: policyIsOff(policy)
      ? 'Security policy turned off'
      : `Security policy updated (MFA ${policy.mfa_all_staff ? 'required' : 'optional'}, step-up ${policy.default_step_up_minutes || 'off'}${policy.default_step_up_minutes ? ' min' : ''}, IP allowlist ${policy.ip_allowlist_enforced ? 'enforced' : 'off'})`,
    metadata: { policy, loosenings, allowlists: parsed.data.allowlists.map((l) => ({ name: l.name, count: l.cidrs.length })) },
  }).catch(() => {});

  return NextResponse.json({ ok: true, policy, policyOff: policyIsOff(policy), loosenings });
}
