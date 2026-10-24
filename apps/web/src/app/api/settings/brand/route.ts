export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { brandScopeQuery, saveBrandSchema } from '@/lib/branding/schema';
import { brandErrorResponse, deleteBrand, loadBrandOverview, saveBrand } from '@/lib/branding/service';

/**
 * Settings → Brand (FPB-branding §5, §8).
 *
 * GET    /api/settings/brand                    the tenant brand + every active company's brand
 *                                               (own / inherits / default) — settings_system:view
 * PUT    /api/settings/brand                    save the tenant (location_id null) or a company
 *                                               brand; colours re-validated + contrast recomputed
 *                                               server-side — settings_system:edit
 * DELETE /api/settings/brand?location_id=…      reset (company → tenant brand; tenant → Merit
 *                                               default) — settings_system:edit
 *
 * brand_profiles is SELECT-only for members (migration 190): writes go through the service
 * role after the permission check, org pinned, company asserted in the caller's scope.
 */

export const GET = apiQueryHandler(null, async (_q, ctx) => {
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'settings_system', 'view');
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json(await loadBrandOverview(supabase, orgId));
  } catch (e) {
    const r = brandErrorResponse(e);
    if (r) return NextResponse.json(r.body, { status: r.status });
    throw e;
  }
});

export const PUT = apiHandler(saveBrandSchema, async (body, ctx) => {
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const guard = await requirePermission(userId, 'settings_system', 'edit', { locationId: body.location_id });
  if (!guard.ok) return guard.response;
  try {
    // apiHandler types the body as the schema output already; re-parse keeps defaults explicit.
    const profile = await saveBrand({ caller: supabase, orgId, userId }, saveBrandSchema.parse(body));
    return NextResponse.json({ profile });
  } catch (e) {
    const r = brandErrorResponse(e);
    if (r) return NextResponse.json(r.body, { status: r.status });
    throw e;
  }
});

export const DELETE = apiQueryHandler(brandScopeQuery, async (q, ctx) => {
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const locationId = q.location_id ?? null;
  const guard = await requirePermission(userId, 'settings_system', 'edit', { locationId });
  if (!guard.ok) return guard.response;
  try {
    await deleteBrand({ caller: supabase, orgId, userId }, locationId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const r = brandErrorResponse(e);
    if (r) return NextResponse.json(r.body, { status: r.status });
    throw e;
  }
});
