export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { formatMoney } from '@meritbooks/shared';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { logHumanAction } from '@/lib/trust/action-log';
import { assertSessionMeetsPolicy } from '@/lib/auth/assert-session-policy';
import { requestClientIp } from '@/lib/auth/client-ip';
import {
  ConflictRuleError,
  applyApproverReleaseChange,
  coreUserIdFor,
  describeApproverRelease,
  planApproverReleaseChange,
  updateSodSettings,
} from '@/lib/rbac/sod-admin';

/**
 * PATCH /api/approvals/conflict-rules/settings — tenant SoD settings:
 *   approverRelease            05 Q1 + mig 174: may the approver also release a payment?
 *                              { choice: 'off' }                       never (default)
 *                              { choice: 'any' }                       yes, any amount
 *                              { choice: 'up_to', maxCents: 500000 }   yes, up to $5,000
 *                              The preparer never releases; payroll always needs a second
 *                              person (DB-enforced, mig 174). Company tenants only.
 *   jeSelfPostThresholdCents   05 Q4: manual JEs at/above this need a second person to post
 *
 * Gate: settings_system:edit, then (approverRelease) the DB requires a TENANT ADMIN
 * (core.set_approver_release_policy). A LOOSENING change (off → on, up-to → any, a higher
 * limit) is accepted only from a session that meets the tenant's CURRENT security policy
 * (assertSessionMeetsPolicy, action configure_locked — the wave-2G security-policy
 * pattern); the DB re-derives "loosening" and refuses it without that attestation.
 * core.organizations is service-write only (mig 154); every write is pinned to the session
 * org, and an approver-release change is logged to core.access_change_log (mig 174 §4).
 */
const MAX_CENTS = 100_000_000_000; // $1B — keeps the JS number exact and the input sane.

const approverRelease = z.discriminatedUnion('choice', [
  z.object({ choice: z.literal('off') }),
  z.object({ choice: z.literal('any') }),
  z.object({ choice: z.literal('up_to'), maxCents: z.number().int().min(1, 'Enter an amount greater than $0').max(MAX_CENTS) }),
]);

const schema = z
  .object({
    approverRelease: approverRelease.optional(),
    jeSelfPostThresholdCents: z.number().int().min(0).max(MAX_CENTS).optional(),
    /** Why (recorded in the access log). Optional. */
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.approverRelease !== undefined || v.jeSelfPostThresholdCents !== undefined, {
    message: 'Nothing to change',
  });

export const PATCH = apiHandler(schema, async (body, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const orgId = ctx.orgId;
  const guard = await requirePermission(ctx.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  const admin = createAdminSupabase();

  const summary: string[] = [];
  const metadata: Record<string, unknown> = {};
  try {
    if (body.approverRelease) {
      const requested = body.approverRelease.choice === 'up_to'
        ? { choice: 'up_to' as const, maxCents: body.approverRelease.maxCents }
        : { choice: body.approverRelease.choice, maxCents: null };
      const plan = await planApproverReleaseChange(admin, orgId, requested);
      if (!plan.unchanged) {
        if (plan.loosening) {
          const sp = await assertSessionMeetsPolicy({ orgId, userId: ctx.userId }, { action: 'configure_locked' });
          if (!sp.ok) return sp.response;
        }
        const actorUserId = await coreUserIdFor(admin, ctx.userId);
        if (!actorUserId) {
          return NextResponse.json({ error: 'Only a tenant admin can change who may release payments.' }, { status: 403 });
        }
        await applyApproverReleaseChange(admin, orgId, plan.next, {
          actorUserId,
          sessionPolicyMet: plan.loosening,
          reason: body.reason ?? null,
          ip: requestClientIp(),
        });
        summary.push(describeApproverRelease(plan.next, formatMoney));
        metadata.approverRelease = { before: plan.current, after: plan.next, loosening: plan.loosening };
      }
    }
    if (body.jeSelfPostThresholdCents !== undefined) {
      await updateSodSettings(admin, orgId, { jeSelfPostThresholdCents: body.jeSelfPostThresholdCents });
      summary.push(`Journal entry self-post limit set to ${formatMoney(body.jeSelfPostThresholdCents)}`);
      metadata.jeSelfPostThresholdCents = body.jeSelfPostThresholdCents;
    }
  } catch (e) {
    if (e instanceof ConflictRuleError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  if (summary.length > 0) {
    await logHumanAction(ctx.supabase, ctx.userId, orgId, {
      action: 'sod.settings.update',
      subjectTable: 'organizations',
      subjectId: orgId,
      summary: summary.join('; '),
      metadata,
    });
  }
  return NextResponse.json({ ok: true, changed: summary.length > 0 });
});
