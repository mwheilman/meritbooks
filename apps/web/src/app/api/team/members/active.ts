import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Flip a member's is_active flag, scoped to the org. Shared by the
 * deactivate/reactivate routes so the two only differ by a boolean.
 */
export async function setMemberActive(
  supabase: SupabaseClient,
  orgId: string,
  memberId: string,
  isActive: boolean
): Promise<NextResponse> {
  const { data, error } = await supabase
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
