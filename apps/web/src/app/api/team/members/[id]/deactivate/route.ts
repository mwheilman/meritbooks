export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requireManageUsers } from '@/lib/team/guard';
import { setMemberActive } from '../../active';

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

  return setMemberActive(supabase, orgId!, params.id, false);
}
