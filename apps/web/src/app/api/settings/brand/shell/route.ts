export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { loadBrand } from '@/lib/branding/resolve';
import { shellBrandOf } from '@/lib/branding/shell';

/**
 * GET /api/settings/brand/shell — the tenant brand for the app shell's brand area
 * (FPB-branding §4.1, AC-10). Any signed-in member of the org: it carries only the tenant's
 * logo URLs, organization name and brand colour — all already public on every invoice.
 * Read through the member's RLS client (brand_profiles member_read).
 */
export const GET = apiQueryHandler(null, async (_q, ctx) => {
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ brand: null });
  const [brand, org] = await Promise.all([
    loadBrand(supabase, orgId, null),
    supabase.schema('core').from('organizations').select('name').eq('id', orgId).maybeSingle(),
  ]);
  const name = ((org.data as { name?: string } | null)?.name ?? '').trim();
  return NextResponse.json(
    { brand: shellBrandOf(brand, name) },
    { headers: { 'Cache-Control': 'private, max-age=60' } },
  );
});
