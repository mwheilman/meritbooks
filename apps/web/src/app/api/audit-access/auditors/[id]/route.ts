export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { EXTERNAL_AUDITOR_ROLE_KEY } from '@/lib/audit-access/external-auditor-role';
import { logHumanAction } from '@/lib/trust/action-log';

/**
 * DELETE /api/audit-access/auditors/[id] — revoke an external auditor's access by
 * deactivating their seat (is_active=false). Both the page-guard and route-guard require an
 * ACTIVE employee row, so deactivation immediately cuts off all access. Admin-only; scoped
 * to seats that actually carry the External Auditor role (defense in depth).
 */
export async function DELETE(_request: Request, { params }: { params: { id: string } }): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  const { data, error } = await supabase
    .schema('core')
    .from('employees')
    .update({ is_active: false })
    .eq('id', params.id)
    .eq('org_id', orgId!)
    .eq('role', EXTERNAL_AUDITOR_ROLE_KEY)
    .select('id, email')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message, code: 'UPDATE_ERROR' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'No matching external-auditor seat', code: 'NOT_FOUND' }, { status: 404 });
  }

  await logHumanAction(supabase, userId, orgId!, {
    action: 'audit_access.auditor.revoke',
    subjectTable: 'employees',
    subjectId: params.id,
    summary: `Revoked external-auditor access for ${(data as { email?: string }).email ?? params.id}`,
    metadata: { employeeId: params.id },
  });

  return NextResponse.json({ ok: true });
}
