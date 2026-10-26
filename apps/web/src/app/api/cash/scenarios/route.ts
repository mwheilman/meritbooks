export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { createScenarioSchema, scopeQuery, updateScenarioSchema } from '@/lib/validations/cash-forecast';
import { cashError, cashRouteCtx, cashWriter, logEvent, requireOrgWide } from '@/lib/cash/forecast/route-support';
import { loadScenarios } from '@/lib/cash/forecast/load';
import { presetAdjustments } from '@/lib/cash/forecast/scenario';

/**
 * /api/cash/scenarios — saved cash-forecast scenarios (migration 192).
 *   GET   ?location_id     scenarios visible for the scope (org-wide + that company), with levers
 *   POST  {name, kind, location_id?, description?, with_presets?}   create (Downside / Upside seed presets)
 *   PATCH {id, name?, description?, is_archived?}                    rename / archive / restore
 * View = cash.forecast:view; writes = cash.forecast:edit, service role after the client-scope assert.
 * An all-companies scenario (location_id null) is created / changed only by a caller with
 * all-clients scope (security review M1).
 */
export const GET = apiQueryHandler(scopeQuery, async (q, ctx) => {
  const c = await cashRouteCtx(ctx, q.location_id, 'view');
  if (c instanceof NextResponse) return c;
  try {
    const ids = new Set(c.allCompanies.map((x) => x.id));
    const all = await loadScenarios(c.supabase, c.orgId, { includeArchived: true });
    const visible = all.filter((s) => !s.companyId || (ids.has(s.companyId) && (!c.locationId || s.companyId === c.locationId)));
    return NextResponse.json({ scenarios: visible, companies: c.allCompanies.map((x) => ({ id: x.id, name: x.name })) });
  } catch (e) {
    return cashError(e, 'scenarios list');
  }
});

export const POST = apiHandler(createScenarioSchema, async (body, ctx) => {
  const loc = body.location_id ?? null;
  const kind = body.kind ?? 'CUSTOM';
  const c = await cashRouteCtx(ctx, loc, 'edit');
  if (c instanceof NextResponse) return c;
  const denied = requireOrgWide(c, loc);
  if (denied) return denied;
  try {
    const w = await cashWriter(c, [loc]);
    const { data, error } = await w
      .from('cash_forecast_scenarios')
      .insert({ org_id: c.orgId, location_id: loc, name: body.name, kind, description: body.description ?? null, created_by: c.userId, updated_by: c.userId })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    const id = String((data as { id: string }).id);
    const presets = body.with_presets ? presetAdjustments(kind) : [];
    if (presets.length) {
      const { error: e2 } = await w.from('cash_forecast_adjustments').insert(
        presets.map((p) => ({
          org_id: c.orgId,
          scenario_id: id,
          location_id: loc,
          kind: p.kind,
          days: p.days ?? null,
          bps: p.bps ?? null,
          label: p.label ?? null,
          created_by: c.userId,
        })),
      );
      if (e2) throw new Error(e2.message);
    }
    await logEvent(w, c, 'SCENARIO_CREATED', loc, id, { kind, presets: presets.length }, body.name);
    return NextResponse.json({ id, presets: presets.length }, { status: 201 });
  } catch (e) {
    return cashError(e, 'scenario create');
  }
});

export const PATCH = apiHandler(updateScenarioSchema, async (body, ctx) => {
  // Read through RLS first (proves the caller can see it and gives the company it lives on).
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
  const { data: row, error: readErr } = await ctx.supabase.from('cash_forecast_scenarios').select('id, location_id, name').eq('id', body.id).maybeSingle();
  if (readErr) return cashError(readErr, 'scenario read');
  if (!row) return NextResponse.json({ error: 'Scenario not found', code: 'NOT_FOUND' }, { status: 404 });
  const loc = (row as { location_id: string | null }).location_id;
  const c = await cashRouteCtx(ctx, loc, 'edit');
  if (c instanceof NextResponse) return c;
  const denied = requireOrgWide(c, loc);
  if (denied) return denied;
  try {
    const w = await cashWriter(c, [loc]);
    const patch: Record<string, unknown> = { updated_by: c.userId };
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.is_archived !== undefined) patch.is_archived = body.is_archived;
    const { error } = await w.from('cash_forecast_scenarios').update(patch).eq('id', body.id).eq('org_id', c.orgId);
    if (error) throw new Error(error.message);
    await logEvent(w, c, body.is_archived === true ? 'SCENARIO_ARCHIVED' : 'SCENARIO_UPDATED', loc, body.id, patch);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return cashError(e, 'scenario update');
  }
});
