export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { setMemberActive } from '../../active';
import { logHumanAction } from '@/lib/trust/action-log';
import { syncMembershipActiveState } from '@/lib/identity/sync-membership';

/**
 * POST /api/team/members/[id]/reactivate
 * Re-enable a previously deactivated member (is_active = true).
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId } = ctx;

  const grant = await requireManageUsers(supabase, userId, orgId);
  if (grant instanceof NextResponse) return grant;

  const res = await setMemberActive(supabase, orgId!, params.id, true);
  if (res.ok) {
    // Reconcile the canonical spine: employee reactivated -> membership active,
    // so authority resolves off the membership again. Fail-safe (never throws).
    await syncMembershipActiveState(orgId!, params.id, true);
    await logHumanAction(supabase, userId, orgId!, {
      action: 'team.member.reactivate',
      subjectTable: 'employees',
      subjectId: params.id,
      summary: 'Reactivated member',
    });
  }
  return res;
}
