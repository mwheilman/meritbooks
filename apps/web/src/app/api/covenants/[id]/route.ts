export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { buildCovenantStatus, type CovenantRow } from '@/lib/covenants/status';
import { updateCovenantSchema } from '@/lib/covenants/schema';

/**
 * /api/covenants/[id]
 *
 * GET    — one covenant with its current computed status.
 * PATCH  — edit a covenant definition (partial). RLS scopes the update to the org.
 * DELETE — remove a covenant (measurements cascade).
 *
 * Dynamic-param routes can't use the apiHandler wrapper (it only forwards the
 * request), so these validate the body with the shared Zod schema by hand.
 */

const SELECT =
  'id, location_id, loan_name, facility, lender_name, covenant_type, threshold, direction, ' +
  'test_frequency, warn_headroom_pct, measurement, status, effective_date, maturity_date, notes, ' +
  'created_at, updated_at';

interface Params {
  params: { id: string };
}

export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const { data, error } = await ctx.supabase
    .from('loan_covenants')
    .select(SELECT)
    .eq('id', params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message, code: 'INTERNAL_ERROR' }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });

  const periodEnd = new URL(request.url).searchParams.get('period_end') ?? undefined;
  const status = await buildCovenantStatus(ctx.supabase, data as CovenantRow, periodEnd);
  return NextResponse.json({ data: status });
}

export async function PATCH(request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const parsed = updateCovenantSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', code: 'VALIDATION_ERROR' }, { status: 422 });
  }

  const b = parsed.data;
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (b.loan_name !== undefined) patch.loan_name = b.loan_name;
  if (b.facility !== undefined) patch.facility = b.facility ?? null;
  if (b.lender_name !== undefined) patch.lender_name = b.lender_name ?? null;
  if (b.location_id !== undefined) patch.location_id = b.location_id ?? null;
  if (b.covenant_type !== undefined) patch.covenant_type = b.covenant_type;
  if (b.threshold !== undefined) patch.threshold = b.threshold;
  if (b.direction !== undefined) patch.direction = b.direction;
  if (b.test_frequency !== undefined) patch.test_frequency = b.test_frequency;
  if (b.warn_headroom_pct !== undefined) patch.warn_headroom_pct = b.warn_headroom_pct;
  if (b.measurement !== undefined) patch.measurement = b.measurement ?? {};
  if (b.status !== undefined) patch.status = b.status;
  if (b.effective_date !== undefined) patch.effective_date = b.effective_date ?? null;
  if (b.maturity_date !== undefined) patch.maturity_date = b.maturity_date ?? null;
  if (b.notes !== undefined) patch.notes = b.notes ?? null;

  const { error } = await ctx.supabase.from('loan_covenants').update(patch).eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message, code: 'UPDATE_FAILED' }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const { error } = await ctx.supabase.from('loan_covenants').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message, code: 'DELETE_FAILED' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
