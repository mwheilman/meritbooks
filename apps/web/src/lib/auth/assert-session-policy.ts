/**
 * Server enforcement of the tenant authentication policy (05 §3.8, R-7).
 *
 *   const sp = await assertSessionMeetsPolicy({ orgId, userId }, { action: 'money_release' });
 *   if (!sp.ok) return sp.response;   // 403 with { code, obligation: 'step_up', … }
 *
 * FACTS come from Clerk:
 *   - factor-verification age → auth().factorVerificationAge ([first, second] minutes,
 *     -1 = never verified; from the session token's `fva` claim). null when the claim
 *     is absent.
 *   - session created / last active → clerkClient().sessions.getSession(sid), fetched
 *     ONLY when the tenant set a session-age or idle limit.
 *   - client IP → the platform-set x-vercel-forwarded-for / x-real-ip header
 *     (lib/auth/client-ip.ts — never the client-controlled first x-forwarded-for hop),
 *     read ONLY when the IP allowlist is enforced.
 *
 * A denial is returned in Clerk's reverification-error shape (`clerk_error`, reason
 * "reverification-error") merged with our own `code` / `obligation` / `message`, so a
 * client wrapped in Clerk's `useReverification()` gets the re-verify prompt instead of
 * a dead 403, and any other client can branch on `isSessionPolicyError(body)`.
 *
 * SERVER ONLY (next/headers + @clerk/nextjs/server).
 */

import { NextResponse } from 'next/server';
import { auth, clerkClient, reverificationError } from '@clerk/nextjs/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { requestClientIp } from '@/lib/auth/client-ip';
import {
  DEFAULT_SECURITY_POLICY,
  evaluateSessionPolicy,
  normalizeSecurityPolicy,
  type SecurityPolicy,
  type SessionAction,
  type SessionFacts,
  type SessionPolicyDecision,
  type StepUpErrorBody,
} from '@/lib/auth/session-policy';

export interface LoadedSecurityPolicy {
  policy: SecurityPolicy;
  cidrs: string[];
  /** false when the policy storage isn't migrated yet (policy treated as off). */
  available: boolean;
}

/** Read the tenant's policy + allowlist CIDRs (service role, pinned to the org). */
export async function loadSecurityPolicy(admin: SupabaseClient, orgId: string): Promise<LoadedSecurityPolicy> {
  const { data, error } = await admin
    .schema('core').from('organizations')
    .select('security_policy')
    .eq('id', orgId)
    .maybeSingle();
  if (error) {
    // 42703 = undefined_column: migration 167 not applied yet → no policy exists.
    if (error.code === '42703') return { policy: DEFAULT_SECURITY_POLICY, cidrs: [], available: false };
    throw new Error(`security policy read failed: ${error.message}`);
  }
  const policy = normalizeSecurityPolicy((data as { security_policy: unknown } | null)?.security_policy);
  let cidrs: string[] = [];
  if (policy.ip_allowlist_enforced) {
    const { data: lists, error: lerr } = await admin
      .schema('core').from('ip_allowlists')
      .select('cidrs')
      .eq('org_id', orgId);
    if (lerr) throw new Error(`ip allowlist read failed: ${lerr.message}`);
    cidrs = ((lists ?? []) as Array<{ cidrs: string[] | null }>).flatMap((l) => l.cidrs ?? []);
  }
  return { policy, cidrs, available: true };
}

export type SessionPolicyCheck =
  | { ok: true; warnings: string[] }
  | { ok: false; response: NextResponse; decision: Exclude<SessionPolicyDecision, { ok: true }> };

export async function assertSessionMeetsPolicy(
  ctx: { orgId: string; userId: string },
  opts: { action: SessionAction },
): Promise<SessionPolicyCheck> {
  let loaded: LoadedSecurityPolicy;
  try {
    loaded = await loadSecurityPolicy(createAdminSupabase(), ctx.orgId);
  } catch {
    // We cannot know whether a policy is on → fail CLOSED for a sensitive action.
    const decision = {
      ok: false as const, code: 'POLICY_UNVERIFIABLE' as const, obligation: 'blocked' as const,
      message: 'Your workspace security policy could not be checked. Try again in a moment.', reverification: null,
    };
    return { ok: false, decision, response: deniedResponse(decision, 503) };
  }

  const { policy, cidrs } = loaded;
  const facts: SessionFacts = {
    factorVerificationAge: null,
    sessionCreatedAt: null,
    lastActiveAt: null,
    clientIp: policy.ip_allowlist_enforced ? requestClientIp() : null,
    now: new Date(),
  };

  const a = await auth().catch(() => null);
  if (a?.userId && a.userId === ctx.userId) {
    const authObj = a as { factorVerificationAge?: [number, number] | null; sessionId?: string | null };
    facts.factorVerificationAge = authObj.factorVerificationAge ?? null;
    const sessionId = authObj.sessionId ?? null;
    if ((policy.session_max_hours != null || policy.idle_timeout_minutes != null) && sessionId) {
      try {
        const client = await clerkClient();
        const session = await client.sessions.getSession(sessionId);
        facts.sessionCreatedAt = session.createdAt ? new Date(session.createdAt) : null;
        facts.lastActiveAt = session.lastActiveAt ? new Date(session.lastActiveAt) : null;
      } catch {
        /* facts stay null → the policy check fails closed */
      }
    }
  }

  const decision = evaluateSessionPolicy(policy, cidrs, facts, opts.action);
  if (decision.ok) {
    return { ok: true, warnings: loaded.available ? decision.warnings : [...decision.warnings, 'policy_storage_unavailable'] };
  }
  return { ok: false, decision, response: deniedResponse(decision, 403) };
}

function deniedResponse(decision: Exclude<SessionPolicyDecision, { ok: true }>, status: number): NextResponse {
  const body: StepUpErrorBody = {
    error: decision.message,
    code: decision.code,
    obligation: decision.obligation,
    reverification: decision.reverification,
  };
  // Clerk's reverification hint → `useReverification()` on the client re-prompts.
  const clerkHint = decision.reverification ? reverificationError(decision.reverification) : {};
  return NextResponse.json({ ...clerkHint, ...body }, { status });
}
