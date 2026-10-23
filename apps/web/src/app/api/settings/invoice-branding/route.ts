export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';

/**
 * GET /api/settings/invoice-branding — the companies Settings → Invoice Display lists
 * (for the per-company payment / retainage defaults that still live there).
 *
 * The one-template-per-company branding PUT was retired in Slice 1B (migration 176):
 * invoice design is now a template library at /api/invoice-templates, edited on
 * Invoices → Design, and invoice_templates is SELECT-only for members.
 */
export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { data: locations, error } = await supabase
    .schema('core').from('locations')
    .select('id, name, short_code')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    entities: (locations ?? []).map((l: { id: string; name: string; short_code: string | null }) => ({
      locationId: l.id, name: l.name, shortCode: l.short_code,
    })),
  });
}
