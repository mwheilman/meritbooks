export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { createItemSchema, idQuery, scopeQuery, updateItemSchema, type CreateItemInput } from '@/lib/validations/cash-forecast';
import { cashError, cashRouteCtx, cashWriter, logEvent } from '@/lib/cash/forecast/route-support';
import { loadManualItems } from '@/lib/cash/forecast/load';
import { assertOrgRefs, serviceWriter, WriteScopeError } from '@/lib/db/scoped-writer';

/**
 * /api/cash/items — manual forecast lines with notes (deposits, capex, distributions, transfers,
 * line draws …; migration 192).
 *   GET    ?location_id    the scope's items (active and inactive)
 *   POST   {…}             add
 *   PATCH  {id, …}         edit (or is_active false to pause)
 *   DELETE ?id=            remove
 * cash.forecast:view to read, :edit to write; service role after the client-scope assert on the
 * owning company (the transfer counterparty is checked as an org-only reference).
 */
export const GET = apiQueryHandler(scopeQuery, async (q, ctx) => {
  const c = await cashRouteCtx(ctx, q.location_id, 'view');
  if (c instanceof NextResponse) return c;
  try {
    const items = await loadManualItems(c.supabase, c.companies.map((x) => x.id));
    return NextResponse.json({ items, today: c.today });
  } catch (e) {
    return cashError(e, 'items list');
  }
});

/**
 * Security review M1: the scenario and GL account an item references must belong to the org (the
 * write is the service role, so a foreign id would otherwise ride in through the FK), and a
 * scenario-specific item must sit in an all-companies scenario or one for the item's own company.
 */
async function assertItemRefs(orgId: string, b: { location_id: string; scenario_id?: string | null; account_id?: string | null }): Promise<void> {
  await assertOrgRefs(orgId, [
    { table: 'cash_forecast_scenarios', ids: [b.scenario_id], label: 'scenario' },
    { table: 'accounts', ids: [b.account_id], label: 'account' },
  ]);
  if (!b.scenario_id) return;
  const { data } = await serviceWriter().from('cash_forecast_scenarios').select('location_id').eq('org_id', orgId).eq('id', b.scenario_id).maybeSingle();
  const scLoc = (data as { location_id: string | null } | null)?.location_id ?? null;
  if (scLoc && scLoc !== b.location_id) throw new WriteScopeError('That scenario is for another company.');
}

type ItemBody = Partial<CreateItemInput> & Pick<CreateItemInput, 'location_id' | 'direction' | 'category' | 'label' | 'expected_date' | 'amount_cents'>;

function rowOf(b: ItemBody) {
  return {
    location_id: b.location_id,
    scenario_id: b.scenario_id ?? null,
    direction: b.direction,
    category: b.category,
    label: b.label,
    expected_date: b.expected_date,
    amount_cents: b.amount_cents,
    probability_bps: b.probability_bps ?? 10_000,
    recurrence: b.recurrence ?? 'NONE',
    recurrence_end: (b.recurrence ?? 'NONE') === 'NONE' ? null : (b.recurrence_end ?? null),
    counterparty_location_id: b.counterparty_location_id ?? null,
    account_id: b.account_id ?? null,
    note: b.note ?? null,
  };
}

export const POST = apiHandler(createItemSchema, async (body, ctx) => {
  const c = await cashRouteCtx(ctx, body.location_id, 'edit');
  if (c instanceof NextResponse) return c;
  try {
    const w = await cashWriter(c, [body.location_id], [body.counterparty_location_id]);
    await assertItemRefs(c.orgId, body);
    const { data, error } = await w.from('cash_forecast_items').insert({ org_id: c.orgId, ...rowOf(body), created_by: c.userId, updated_by: c.userId }).select('id').single();
    if (error) throw new Error(error.message);
    const id = String((data as { id: string }).id);
    await logEvent(w, c, 'ITEM_CREATED', body.location_id, id, { category: body.category, amount_cents: body.amount_cents, expected_date: body.expected_date }, body.label);
    return NextResponse.json({ id }, { status: 201 });
  } catch (e) {
    return cashError(e, 'item create');
  }
});

export const PATCH = apiHandler(updateItemSchema, async (body, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
  const { data: row, error: readErr } = await ctx.supabase.from('cash_forecast_items').select('id, location_id').eq('id', body.id).maybeSingle();
  if (readErr) return cashError(readErr, 'item read');
  if (!row) return NextResponse.json({ error: 'Item not found', code: 'NOT_FOUND' }, { status: 404 });
  const owner = (row as { location_id: string }).location_id;
  if (owner !== body.location_id) return NextResponse.json({ error: 'An item can’t move to another company — add it there instead.', code: 'VALIDATION_ERROR' }, { status: 422 });
  const c = await cashRouteCtx(ctx, owner, 'edit');
  if (c instanceof NextResponse) return c;
  try {
    const w = await cashWriter(c, [owner], [body.counterparty_location_id]);
    await assertItemRefs(c.orgId, { location_id: owner, scenario_id: body.scenario_id, account_id: body.account_id });
    const { id, is_active, ...rest } = body;
    const patch: Record<string, unknown> = { ...rowOf(rest), updated_by: c.userId };
    if (is_active !== undefined) patch.is_active = is_active;
    const { error } = await w.from('cash_forecast_items').update(patch).eq('id', id).eq('org_id', c.orgId);
    if (error) throw new Error(error.message);
    await logEvent(w, c, 'ITEM_UPDATED', owner, id, { amount_cents: body.amount_cents, expected_date: body.expected_date, is_active: is_active ?? null }, body.label);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return cashError(e, 'item update');
  }
});

export const DELETE = apiQueryHandler(idQuery, async (q, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
  const { data: row, error: readErr } = await ctx.supabase.from('cash_forecast_items').select('id, location_id, label').eq('id', q.id).maybeSingle();
  if (readErr) return cashError(readErr, 'item read');
  if (!row) return NextResponse.json({ error: 'Item not found', code: 'NOT_FOUND' }, { status: 404 });
  const r = row as { location_id: string; label: string };
  const c = await cashRouteCtx(ctx, r.location_id, 'edit');
  if (c instanceof NextResponse) return c;
  try {
    const w = await cashWriter(c, [r.location_id]);
    const { error } = await w.from('cash_forecast_items').delete().eq('id', q.id).eq('org_id', c.orgId);
    if (error) throw new Error(error.message);
    await logEvent(w, c, 'ITEM_REMOVED', r.location_id, q.id, {}, r.label);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return cashError(e, 'item delete');
  }
});
