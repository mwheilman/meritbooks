export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { logHumanAction } from '@/lib/trust/action-log';
import { coreUserIdFor } from '@/lib/rbac/sod-admin';
import { revokeSodException } from '@/lib/rbac/sod-store';

/**
 * DELETE /api/approvals/conflict-rules/allowed — remove an allowed conflict
 * (core.sod_exceptions). Rows are never deleted: the exception is REVOKED (stamped
 * revoked_at / revoked_by / reason) so it stays in the audit trail. Revoking never needs
 * a second approval (05 §4.2). After this, the person's conflicting access shows up as an
 * open conflict in review until one side is removed.
 * Gate: settings_system:edit (→ core.access.sod_policy:configure after the flip).
 */
const schema = z.object({
  exceptionId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

export const DELETE = apiHandler(schema, async (body, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(ctx.userId, 'settings_system', 'edit');
  if (!guard.ok) return guard.response;
  const admin = createAdminSupabase();
  const actor = await coreUserIdFor(admin, ctx.userId);
  if (!actor) return NextResponse.json({ error: 'Your user record was not found' }, { status: 403 });
  try {
    await revokeSodException(admin, ctx.orgId, body.exceptionId, actor, body.reason ?? null);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not remove' }, { status: 404 });
  }
  await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
    action: 'sod.exception.revoke',
    subjectTable: 'sod_exceptions',
    subjectId: body.exceptionId,
    summary: 'Removed an allowed conflict',
    metadata: { reason: body.reason ?? null },
  });
  return NextResponse.json({ ok: true });
});
