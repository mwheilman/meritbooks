export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { setMemberActive } from '../../active';
import { logHumanAction } from '@/lib/trust/action-log';
import { syncMembershipActiveState } from '@/lib/identity/sync-membership';

/**
 * POST /api/team/members/[id]/deactivate
 * Soft-disable a member (is_active = false). Login link is preserved.
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  const res = await setMemberActive(supabase, orgId!, params.id, false);
  if (res.ok) {
    // Reconcile the canonical spine: employee deactivated -> membership suspended,
    // so the membership can no longer be more permissive than the employee record.
    // Fail-safe (never throws) — a sync failure must not undo the deactivation the
    // admin just requested; the interim canApprove is_active guard backs this up.
    await syncMembershipActiveState(orgId!, params.id, false);
    await logHumanAction(supabase, userId, orgId!, {
      action: 'team.member.deactivate',
      subjectTable: 'employees',
      subjectId: params.id,
      summary: 'Deactivated member',
    });
  }
  return res;
}
