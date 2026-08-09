export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { setOverrideSchema, resetOverrideSchema } from '@/lib/validations/rbac';
import { isValidCell } from '@/lib/rbac/permission-catalog';
import { resolveRoleKind } from '@/lib/rbac/resolve-permissions';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * PUT /api/rbac/overrides  — set (grant/deny) one (role, feature, action) cell.
 * DELETE /api/rbac/overrides — reset one cell back to the system default.
 *
 * Admin-only (requireManageUsers, no new permission key). Every write is validated
 * three ways before it can touch the table, and fails closed otherwise:
 *   1. Zod shape.
 *   2. (feature, action) MUST be a real catalog cell (isValidCell) — no phantom grants.
 *   3. roleKey MUST resolve (resolveRoleKind) to a known system OR custom role in THIS
 *      org — you cannot write an override for a role that does not exist.
 * The (org, role, feature, action) unique index makes the upsert idempotent.
 */
export async function PUT(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  const parsed = setOverrideSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }
  const { roleKey, feature, action, allowed } = parsed.data;

  const invalid = await validateCell(supabase, orgId!, roleKey, feature, action);
  if (invalid) return invalid;

  const { error } = await supabase
    .schema('core')
    .from('role_permission_overrides')
    .upsert(
      {
        org_id: orgId!,
        role_key: roleKey,
        feature,
        action,
        allowed,
        set_by: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id,role_key,feature,action' },
    );

  if (error) {
    return NextResponse.json({ error: error.message, code: 'UPSERT_ERROR' }, { status: 500 });
  }

  await logHumanAction(supabase, userId, orgId!, {
    action: 'rbac.override.set',
    subjectTable: 'role_permission_overrides',
    subjectId: `${roleKey}:${feature}:${action}`,
    summary: `${allowed ? 'Granted' : 'Revoked'} ${feature}.${action} for role ${roleKey}`,
    metadata: { roleKey, feature, action, allowed },
  });

  return NextResponse.json({ data: { roleKey, feature, action, allowed } });
}

export async function DELETE(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  const parsed = resetOverrideSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors },
      { status: 422 },
    );
  }
  const { roleKey, feature, action } = parsed.data;

  const { error } = await supabase
    .schema('core')
    .from('role_permission_overrides')
    .delete()
    .eq('org_id', orgId!)
    .eq('role_key', roleKey)
    .eq('feature', feature)
    .eq('action', action);

  if (error) {
    return NextResponse.json({ error: error.message, code: 'DELETE_ERROR' }, { status: 500 });
  }

  await logHumanAction(supabase, userId, orgId!, {
    action: 'rbac.override.reset',
    subjectTable: 'role_permission_overrides',
    subjectId: `${roleKey}:${feature}:${action}`,
    summary: `Reset ${feature}.${action} to default for role ${roleKey}`,
    metadata: { roleKey, feature, action },
  });

  return NextResponse.json({ data: { roleKey, feature, action, reset: true } });
}

/**
 * Shared cell validation: the (feature, action) must be a real catalog cell AND the
 * roleKey must resolve to a known role in this org. Returns a NextResponse to return on
 * failure, or null when the cell is writable.
 */
async function validateCell(
  supabase: Parameters<typeof resolveRoleKind>[0],
  orgId: string,
  roleKey: string,
  feature: string,
  action: string,
): Promise<NextResponse | null> {
  if (!isValidCell(feature, action)) {
    return NextResponse.json(
      { error: 'Unknown feature or action', code: 'UNKNOWN_CELL' },
      { status: 422 },
    );
  }
  const kind = await resolveRoleKind(supabase, orgId, roleKey);
  if (!kind) {
    return NextResponse.json(
      { error: 'Unknown role', code: 'UNKNOWN_ROLE' },
      { status: 404 },
    );
  }
  return null;
}
