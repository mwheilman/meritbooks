export const dynamic = 'force-dynamic';

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { addToPackSchema, MAX_PACK_ITEMS, NEW_PACK_SPECS, parsePackItems, type PackItem } from '@/lib/fpna/workspace/pack-items';
import { noOrg, workspaceErrorResponse } from '@/lib/fpna/workspace/server/route-support';
import { isWriteScopeError, serviceWriter } from '@/lib/db/scoped-writer';
import { assertPackWriteScope, itemWithinPack } from '@/lib/reports/compiler/pack-scope';

/**
 * POST /api/fpna/workspace/add-to-pack — add the dashboard (its layout + scope, never
 * figures) to an existing report pack, or to a new one seeded with last month's P&L and
 * balance sheet. Scheduled delivery renders it for the last complete month, governed as
 * non-finance, as a PDF attachment. reports:export.
 * Security review H3: report_packs is SELECT-only for members (191 §2b). The pack is read through
 * RLS (org + client scope); the companies of the pack ∪ every dashboard in it are checked against
 * the caller's scope (all companies → all-clients scope); a dashboard must sit inside an existing
 * pack's companies; then the service role writes with the org pinned. Delivery re-checks.
 * Saving never schedules anything: delivery stays a separate, explicit pack setting.
 */
export const POST = apiHandler(addToPackSchema, async (b, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'reports', 'export', { route: '/api/fpna/workspace/add-to-pack' });
  if (!guard.ok) return guard.response;
  const item: PackItem = {
    id: randomUUID(),
    name: b.name,
    packKey: b.packKey,
    cards: b.cards,
    settings: b.settings,
    companies: b.companies,
    weighting: b.weighting,
    sourceRef: b.dashboardRef,
    addedBy: ctx.userId,
    addedAt: new Date().toISOString(),
  };
  const forbidden = (e: unknown) => (isWriteScopeError(e) ? NextResponse.json({ error: e.message, code: 'FORBIDDEN' }, { status: 403 }) : null);
  try {
    if (b.newPackName) {
      try {
        await assertPackWriteScope(ctx.supabase, ctx.orgId, b.companies, [item]);
      } catch (e) {
        const r = forbidden(e);
        if (r) return r;
        throw e;
      }
      const { data, error } = await serviceWriter()
        .from('report_packs')
        .insert({ org_id: ctx.orgId, name: b.newPackName, specs: NEW_PACK_SPECS, entity_label: b.companies.length ? `${b.companies.length} selected companies` : 'All Companies (Consolidated)', location_ids: b.companies, schedule_cadence: 'NONE', recipients: [], schedule_active: false, fpna_items: [item], created_by: ctx.userId })
        .select('id, name')
        .single();
      if (error) throw new Error(`add-to-pack insert: ${error.message}`);
      return NextResponse.json({ pack: data, item }, { status: 201 });
    }
    const { data: pack, error: readErr } = await ctx.supabase.from('report_packs').select('id, name, fpna_items, location_ids').eq('id', b.packId as string).eq('org_id', ctx.orgId).maybeSingle();
    if (readErr) throw new Error(`add-to-pack read: ${readErr.message}`);
    if (!pack) return NextResponse.json({ error: 'That pack no longer exists.', code: 'NOT_FOUND' }, { status: 404 });
    const packLocations = (pack as { location_ids?: unknown }).location_ids;
    const items = parsePackItems((pack as { fpna_items?: unknown }).fpna_items);
    if (items.length >= MAX_PACK_ITEMS) return NextResponse.json({ error: `A pack holds at most ${MAX_PACK_ITEMS} dashboards.`, code: 'PACK_FULL' }, { status: 409 });
    if (!itemWithinPack(item.companies, packLocations)) {
      return NextResponse.json(
        { error: 'This dashboard covers companies that are not in the pack. Pick the pack’s companies, or add it to a new pack.', code: 'OUTSIDE_PACK' },
        { status: 422 },
      );
    }
    try {
      await assertPackWriteScope(ctx.supabase, ctx.orgId, packLocations, [...items, item]);
    } catch (e) {
      const r = forbidden(e);
      if (r) return r;
      throw e;
    }
    const { error } = await serviceWriter().from('report_packs').update({ fpna_items: [...items, item], updated_at: new Date().toISOString() }).eq('id', b.packId as string).eq('org_id', ctx.orgId);
    if (error) throw new Error(`add-to-pack update: ${error.message}`);
    return NextResponse.json({ pack: { id: (pack as { id: string }).id, name: (pack as { name: string }).name }, item });
  } catch (e) {
    return workspaceErrorResponse(e, 'fpna/workspace/add-to-pack');
  }
});
