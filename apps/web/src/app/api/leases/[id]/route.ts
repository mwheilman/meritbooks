export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';

/**
 * /api/leases/[id]
 *
 * GET    — one lease with its full amortization schedule (RLS-scoped).
 * DELETE — remove a lease (schedule lines cascade). Guarded: refuses once any
 *          period has posted to the GL, since those entries can't be silently orphaned.
 */

interface Params {
  params: { id: string };
}

const LEASE_SELECT =
  'id, location_id, lessor, description, classification, commencement_date, end_date, ' +
  'payment_cents, payment_frequency, payment_timing, term_months, discount_rate, ' +
  'rou_asset_cents, liability_cents, status, periods_posted, notes, created_at, updated_at';

const LINE_SELECT =
  'id, period, period_date, payment_cents, interest_cents, principal_reduction_cents, ' +
  'liability_balance_cents, rou_amortization_cents, rou_balance_cents, lease_expense_cents, ' +
  'gl_entry_id, posted_at';

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const { data: lease, error } = await ctx.supabase
    .from('leases')
    .select(LEASE_SELECT)
    .eq('id', params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message, code: 'INTERNAL_ERROR' }, { status: 500 });
  if (!lease) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });

  const { data: lines } = await ctx.supabase
    .from('lease_schedule_lines')
    .select(LINE_SELECT)
    .eq('lease_id', params.id)
    .order('period', { ascending: true });

  return NextResponse.json({ data: { lease, schedule: lines ?? [] } });
}

export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const { data: lease } = await ctx.supabase
    .from('leases')
    .select('id, periods_posted')
    .eq('id', params.id)
    .maybeSingle<{ id: string; periods_posted: number }>();
  if (!lease) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
  if (lease.periods_posted > 0) {
    return NextResponse.json(
      { error: 'This lease has posted GL entries and cannot be deleted. Void the entries first.', code: 'HAS_POSTINGS' },
      { status: 409 },
    );
  }

  const { error } = await ctx.supabase.from('leases').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message, code: 'DELETE_FAILED' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
