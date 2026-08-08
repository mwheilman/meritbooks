export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { createAdminSupabase } from '@/lib/supabase/server';
import { logHumanAction } from '@/lib/trust/action-log';
import {
  INVITATIONS_SCHEMA,
  INVITATIONS_TABLE,
  isMissingInvitationsTable,
} from '@/lib/team/invitations';

/**
 * POST /api/team/invitations/[id]/revoke
 * Revoke a pending invitation so the seat can no longer be claimed. Only pending
 * invitations can be revoked; an already-accepted invite is a member (managed via
 * /api/team/members). Org-scoped and admin-only.
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  const admin = createAdminSupabase();

  const { data: updated, error } = await admin
    .schema(INVITATIONS_SCHEMA)
    .from(INVITATIONS_TABLE)
    .update({ status: 'revoked', revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .eq('org_id', orgId!)
    .eq('status', 'pending')
    .select('id, email')
    .maybeSingle();

  if (error) {
    if (isMissingInvitationsTable(error)) {
      return NextResponse.json({ error: 'Invitations are not available yet.', code: 'INVITATIONS_UNAVAILABLE' }, { status: 503 });
    }
    return NextResponse.json({ error: error.message, code: 'UPDATE_ERROR' }, { status: 500 });
  }
  if (!updated) {
    return NextResponse.json({ error: 'Invitation not found or already resolved.', code: 'NOT_FOUND' }, { status: 404 });
  }

  await logHumanAction(supabase, userId, orgId!, {
    action: 'team.invitation.revoke',
    subjectTable: 'membership_invitations',
    subjectId: params.id,
    summary: `Revoked invitation for ${updated.email}`,
    metadata: {},
  });

  return NextResponse.json({ data: { id: params.id } });
}
