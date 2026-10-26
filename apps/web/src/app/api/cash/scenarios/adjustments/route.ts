export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { createAdjustmentSchema, idQuery } from '@/lib/validations/cash-forecast';
import { cashError, cashRouteCtx, cashWriter, logEvent, requireOrgWide } from '@/lib/cash/forecast/route-support';
import { assertOrgRefs } from '@/lib/db/scoped-writer';

/**
 * /api/cash/scenarios/adjustments — a scenario's levers (migration 192).
 *   POST   {scenario_id, kind, …}   add a lever (delay / haircut receipts, delay disbursements,
 *                                   remove an item, payroll growth, line draw / paydown)
 *   DELETE ?id=                     remove a lever
 * cash.forecast:edit; the scenario is read through RLS first; the lever's company must sit inside
 * the scenario's company (an org-wide scenario takes any company in the caller's scope).
 * Security review M1: an all-companies lever (location_id null) needs all-clients scope, and every
 * referenced id (scenario, customer, vendor, debt instrument) must belong to the org.
 */
export const POST = apiHandler(createAdjustmentSchema, async (body, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
  const { data: sc, error: readErr } = await ctx.supabase.from('cash_forecast_scenarios').select('id, location_id, is_archived').eq('id', body.scenario_id).maybeSingle();
  if (readErr) return cashError(readErr, 'scenario read');
  if (!sc) return NextResponse.json({ error: 'Scenario not found', code: 'NOT_FOUND' }, { status: 404 });
  const scLoc = (sc as { location_id: string | null }).location_id;
  if ((sc as { is_archived: boolean }).is_archived) return NextResponse.json({ error: 'Restore the scenario before changing it.', code: 'CONFLICT' }, { status: 409 });
  if (scLoc && body.location_id && body.location_id !== scLoc) {
    return NextResponse.json({ error: 'This scenario is for another company.', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const loc = body.location_id ?? scLoc;
  const c = await cashRouteCtx(ctx, loc, 'edit');
  if (c instanceof NextResponse) return c;
  const denied = requireOrgWide(c, loc);
  if (denied) return denied;
  try {
    const w = await cashWriter(c, [loc]);
    await assertOrgRefs(c.orgId, [
      { table: 'cash_forecast_scenarios', ids: [body.scenario_id], label: 'scenario' },
      { schema: 'core', table: 'customers', ids: [body.customer_id], label: 'customer' },
      { schema: 'core', table: 'vendors', ids: [body.vendor_id], label: 'vendor' },
      { table: 'debt_instruments', ids: [body.instrument_id], label: 'debt instrument' },
    ], { caller: c.supabase });
    const { data, error } = await w
      .from('cash_forecast_adjustments')
      .insert({
        org_id: c.orgId,
        scenario_id: body.scenario_id,
        location_id: loc,
        kind: body.kind,
        customer_id: body.customer_id ?? null,
        vendor_id: body.vendor_id ?? null,
        instrument_id: body.instrument_id ?? null,
        item_key: body.item_key ?? null,
        days: body.days ?? null,
        bps: body.bps ?? null,
        amount_cents: body.amount_cents ?? null,
        effective_date: body.effective_date ?? null,
        label: body.label ?? null,
        note: body.note ?? null,
        created_by: c.userId,
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    const id = String((data as { id: string }).id);
    await logEvent(w, c, 'ADJUSTMENT_ADDED', loc, body.scenario_id, { adjustment_id: id, kind: body.kind });
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return cashError(e, 'adjustment create');
  }
});

export const DELETE = apiQueryHandler(idQuery, async (q, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
  const { data: row, error: readErr } = await ctx.supabase.from('cash_forecast_adjustments').select('id, location_id, scenario_id, kind').eq('id', q.id).maybeSingle();
  if (readErr) return cashError(readErr, 'adjustment read');
  if (!row) return NextResponse.json({ error: 'Lever not found', code: 'NOT_FOUND' }, { status: 404 });
  const r = row as { location_id: string | null; scenario_id: string; kind: string };
  const c = await cashRouteCtx(ctx, r.location_id, 'edit');
  if (c instanceof NextResponse) return c;
  const denied = requireOrgWide(c, r.location_id);
  if (denied) return denied;
  try {
    const w = await cashWriter(c, [r.location_id]);
    const { error } = await w.from('cash_forecast_adjustments').delete().eq('id', q.id).eq('org_id', c.orgId);
    if (error) throw new Error(error.message);
    await logEvent(w, c, 'ADJUSTMENT_REMOVED', r.location_id, r.scenario_id, { adjustment_id: q.id, kind: r.kind });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return cashError(e, 'adjustment delete');
  }
});
