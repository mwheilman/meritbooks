export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';

/**
 * GET /api/classes
 * Returns the org's active GL classes (a dimension on gl_entry_lines, validated
 * by validate_dimensions when an account/entity sets require_class). Classes are
 * org-wide (no location_id on the table), so the bank-feed edit panel shows the
 * full active list. Added Session 25 to back the class picker on bank-feed txns.
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json([]);

  const { data, error } = await supabase
    .from('classes')
    .select('id, name, code')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}
