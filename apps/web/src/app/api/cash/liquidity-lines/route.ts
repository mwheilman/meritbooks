export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { idQuery, liquidityLineSchema } from '@/lib/validations/cash-forecast';
import { cashError, cashRouteCtx, cashWriter, logEvent } from '@/lib/cash/forecast/route-support';

/**
 * /api/cash/liquidity-lines — revolver / line availability for liquidity headroom (migration 192).
 *   POST   {id?, location_id, name, commitment_cents, borrowing_base_cents?, drawn_cents?, instrument_id?, as_of_date?, note?}
 *          create, or update when `id` is given (the row's company can't change)
 *   DELETE ?id=   deactivate (kept for the audit trail)
 * cash.forecast:edit; service role after the client-scope assert. A linked instrument must belong
 * to the same company (read through RLS).
 */
export const POST = apiHandler(liquidityLineSchema, async (body, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
  if (body.id) {
    const { data: row } = await ctx.supabase.from('cash_liquidity_lines').select('id, location_id').eq('id', body.id).maybeSingle();
    if (!row) return NextResponse.json({ error: 'Line not found', code: 'NOT_FOUND' }, { status: 404 });
    if ((row as { location_id: string }).location_id !== body.location_id) return NextResponse.json({ error: 'A line can’t move to another company.', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  if (body.instrument_id) {
    const { data: inst } = await ctx.supabase.from('debt_instruments').select('id, location_id').eq('id', body.instrument_id).maybeSingle();
    if (!inst || (inst as { location_id: string | null }).location_id !== body.location_id) {
      return NextResponse.json({ error: 'Pick a loan that belongs to this company.', code: 'VALIDATION_ERROR' }, { status: 422 });
    }
  }
  const c = await cashRouteCtx(ctx, body.location_id, 'edit');
  if (c instanceof NextResponse) return c;
  try {
    const w = await cashWriter(c, [body.location_id]);
    const row = {
      org_id: c.orgId,
      location_id: body.location_id,
      instrument_id: body.instrument_id ?? null,
      name: body.name,
      commitment_cents: body.commitment_cents,
      borrowing_base_cents: body.borrowing_base_cents ?? null,
      drawn_cents: body.drawn_cents ?? null,
      as_of_date: body.as_of_date ?? null,
      note: body.note ?? null,
      is_active: true,
      updated_by: c.userId,
    };
    let id = body.id ?? null;
    if (id) {
      const { error } = await w.from('cash_liquidity_lines').update(row).eq('id', id).eq('org_id', c.orgId);
      if (error) throw new Error(error.message);
    } else {
      const { data, error } = await w.from('cash_liquidity_lines').insert(row).select('id').single();
      if (error) throw new Error(error.message);
      id = String((data as { id: string }).id);
    }
    await logEvent(w, c, 'LINE_SAVED', body.location_id, id, { commitment_cents: body.commitment_cents, borrowing_base_cents: body.borrowing_base_cents ?? null }, body.name);
    return NextResponse.json({ id }, { status: body.id ? 200 : 201 });
  } catch (e) {
    return cashError(e, 'line save');
  }
});

export const DELETE = apiQueryHandler(idQuery, async (q, ctx) => {
  if (!ctx.orgId) return NextResponse.json({ error: 'No organization on session', code: 'NO_ORG' }, { status: 403 });
  const { data: row } = await ctx.supabase.from('cash_liquidity_lines').select('id, location_id, name').eq('id', q.id).maybeSingle();
  if (!row) return NextResponse.json({ error: 'Line not found', code: 'NOT_FOUND' }, { status: 404 });
  const r = row as { location_id: string; name: string };
  const c = await cashRouteCtx(ctx, r.location_id, 'edit');
  if (c instanceof NextResponse) return c;
  try {
    const w = await cashWriter(c, [r.location_id]);
    const { error } = await w.from('cash_liquidity_lines').update({ is_active: false, updated_by: c.userId }).eq('id', q.id).eq('org_id', c.orgId);
    if (error) throw new Error(error.message);
    await logEvent(w, c, 'LINE_REMOVED', r.location_id, q.id, {}, r.name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return cashError(e, 'line delete');
  }
});
