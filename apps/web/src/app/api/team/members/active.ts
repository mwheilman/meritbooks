import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';

/**
 * Flip a member's is_active flag, scoped to the org. Shared by the
 * deactivate/reactivate routes so the two only differ by a boolean.
 *
 * core.employees is SELECT-only for members (migration 154), so this writes as the
 * service role. CALLERS MUST have passed requireManageUsers first; `orgId` must be
 * the session-resolved org (never client input) — it pins the row.
 */
export async function setMemberActive(
  orgId: string,
  memberId: string,
  isActive: boolean
): Promise<NextResponse> {
  const { data, error } = await createAdminSupabase()
    .schema('core')
    .from('employees')
    .update({ is_active: isActive })
    .eq('id', memberId)
    .eq('org_id', orgId)
    .select('id')
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message, code: 'UPDATE_ERROR' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Member not found', code: 'NOT_FOUND' }, { status: 404 });
  }

  return NextResponse.json({ data: { id: memberId, isActive } });
}
