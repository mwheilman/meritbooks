export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { logHumanAction } from '@/lib/trust/action-log';
import { ConflictRuleError, updateSodSettings } from '@/lib/rbac/sod-admin';

/**
 * PATCH /api/approvals/conflict-rules/settings — tenant SoD settings (05 Q1, Q4):
 *   soleApproverMode           approver may also release (company tenants only)
 *   jeSelfPostThresholdCents   manual JEs at/above this need a second person to post
 * Gate: settings_system:edit (→ core.access.sod_policy:configure after the flip).
 * core.organizations is service-write only (mig 154); the write is pinned to the session org.
 */
const schema = z
  .object({
    soleApproverMode: z.boolean().optional(),
    // Bigint cents; capped at $1B to keep the JS number exact and the input sane.
    jeSelfPostThresholdCents: z.number().int().min(0).max(100_000_000_000).optional(),
  })
  .refine((v) => v.soleApproverMode !== undefined || v.jeSelfPostThresholdCents !== undefined, {
    message: 'Nothing to change',
  });

export const PATCH = apiHandler(schema, async (body, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  try {
    await updateSodSettings(createAdminSupabase(), ctx.orgId, body);
  } catch (e) {
    if (e instanceof ConflictRuleError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
    action: 'sod.settings.update',
    subjectTable: 'organizations',
    subjectId: ctx.orgId,
    summary: [
      body.soleApproverMode !== undefined ? `One-person approval ${body.soleApproverMode ? 'on' : 'off'}` : null,
      body.jeSelfPostThresholdCents !== undefined ? `Journal entry self-post limit set to ${(body.jeSelfPostThresholdCents / 100).toFixed(2)}` : null,
    ]
      .filter(Boolean)
      .join('; '),
    metadata: { ...body },
  });
  return NextResponse.json({ ok: true });
});
